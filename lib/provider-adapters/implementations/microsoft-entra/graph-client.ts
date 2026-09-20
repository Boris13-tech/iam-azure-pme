import { ConfidentialClientApplication, LogLevel } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";
import "isomorphic-fetch";
import {
  ProviderAdapterError,
  type ProviderOperationContext,
  type SecretResolver,
} from "../..";
import type {
  MicrosoftEntraConnectionConfig,
  MicrosoftEntraCreatedUser,
  MicrosoftEntraGraphUser,
} from "./types";

export interface MicrosoftEntraGraphGateway {
  listUsersRaw(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
  ): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
  listUsers(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
  ): Promise<MicrosoftEntraGraphUser[]>;
  getUser(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    externalObjectId: string,
  ): Promise<MicrosoftEntraGraphUser | null>;
  createUser(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    input: { name: string; email: string; temporaryPassword: string },
  ): Promise<MicrosoftEntraCreatedUser>;
  updateUser(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    externalObjectId: string,
    update: { accountEnabled?: boolean; name?: string; email?: string },
  ): Promise<void>;
}

export class MicrosoftGraphGateway implements MicrosoftEntraGraphGateway {
  constructor(private readonly secrets: SecretResolver) {}

  async listUsersRaw(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
  ): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
    return this.withClient(context, config, async (graph) => {
      const result = await graph.api("/users").get();
      return (result.value ?? []).map(
        (value: Record<string, unknown>) => ({ ...value }),
      );
    });
  }

  async listUsers(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
  ): Promise<MicrosoftEntraGraphUser[]> {
    return this.withClient(context, config, async (graph) => {
      const result = await graph
        .api("/users")
        .select("id,displayName,mail,userPrincipalName,accountEnabled")
        .get();
      return (result.value ?? []).map(toGraphUser);
    });
  }

  async getUser(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    externalObjectId: string,
  ): Promise<MicrosoftEntraGraphUser | null> {
    return this.withClient(context, config, async (graph) => {
      try {
        const value = await graph
          .api(`/users/${encodeURIComponent(externalObjectId)}`)
          .select("id,displayName,mail,userPrincipalName,accountEnabled")
          .get();
        return toGraphUser(value);
      } catch (error: unknown) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  async createUser(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    input: { name: string; email: string; temporaryPassword: string },
  ): Promise<MicrosoftEntraCreatedUser> {
    return this.withClient(context, config, async (graph) => {
      let defaultDomain = "onmicrosoft.com";
      try {
        const domains = await graph.api("/domains").get();
        const primary = (domains.value ?? []).find(
          (domain: { isDefault?: boolean; isInitial?: boolean }) =>
            domain.isDefault || domain.isInitial,
        )?.id;
        if (primary) defaultDomain = primary;
      } catch {
        // Preserve the legacy fallback without exposing provider error details.
      }

      const parts = input.email.split("@");
      const emailDomain = parts[1] ?? "";
      const mailNickname = parts[0].replace(/[^a-zA-Z0-9]/g, "");
      const genericDomains = new Set([
        "gmail.com",
        "yahoo.com",
        "hotmail.com",
        "outlook.com",
        "live.com",
      ]);
      const userPrincipalName = genericDomains.has(emailDomain.toLowerCase())
        ? `${mailNickname}@${defaultDomain}`
        : input.email;
      const created = await graph.api("/users").post({
        accountEnabled: true,
        displayName: input.name,
        mailNickname,
        userPrincipalName,
        mail: input.email,
        passwordProfile: {
          forceChangePasswordNextSignIn: true,
          password: input.temporaryPassword,
        },
      });
      return { id: created.id, userPrincipalName: created.userPrincipalName };
    });
  }

  async updateUser(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    externalObjectId: string,
    update: { accountEnabled?: boolean; name?: string; email?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (update.accountEnabled !== undefined) {
      body.accountEnabled = update.accountEnabled;
    }
    if (update.name !== undefined) body.displayName = update.name;
    if (update.email !== undefined) body.mail = update.email;
    await this.withClient(context, config, (graph) =>
      graph.api(`/users/${encodeURIComponent(externalObjectId)}`).update(body),
    );
  }

  private async withClient<T>(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (!config.graphClientId || !config.graphTenantId || !config.graphClientSecret) {
      throw new ProviderAdapterError({
        code: "MISCONFIGURED",
        message: "Missing Microsoft Graph configuration",
        safeDetails: { providerConnectionId: context.providerConnectionId },
      });
    }
    try {
      return await this.secrets.withSecret(context, config.graphClientSecret, (lease) =>
        lease.use(async (secretBytes) => {
        const secret = new TextDecoder().decode(secretBytes);
        const application = new ConfidentialClientApplication({
          auth: {
            clientId: config.graphClientId!,
            authority: `https://login.microsoftonline.com/${config.graphTenantId}`,
            clientSecret: secret,
          },
          system: {
            loggerOptions: {
              loggerCallback: () => undefined,
              piiLoggingEnabled: false,
              logLevel: LogLevel.Error,
            },
          },
        });
        const token = await application.acquireTokenByClientCredential({
          scopes: ["https://graph.microsoft.com/.default"],
        });
        if (!token?.accessToken) {
          throw new ProviderAdapterError({
            code: "AUTHENTICATION_FAILED",
            message: "Microsoft Graph credential exchange failed",
          });
        }
        const graph = Client.init({
          authProvider: (done) => done(null, token.accessToken),
        });
          return action(graph);
        }),
      );
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError({
        code: "UNAVAILABLE",
        message: "Microsoft Graph operation failed",
        retryable: true,
      });
    }
  }
}

function toGraphUser(value: Record<string, unknown>): MicrosoftEntraGraphUser {
  return {
    id: String(value.id ?? ""),
    displayName: optionalString(value.displayName),
    mail: optionalString(value.mail),
    userPrincipalName: optionalString(value.userPrincipalName),
    accountEnabled:
      typeof value.accountEnabled === "boolean" ? value.accountEnabled : undefined,
    raw: { ...value },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const status = (error as { status?: unknown }).status;
  return statusCode === 404 || status === 404;
}
