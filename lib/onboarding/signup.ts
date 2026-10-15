import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { rawPrisma } from "../db/raw-prisma";
import { createPasskeyIdentity, grantAdministrator } from "./provisioning";
import { normalizeOrganizationSlug, normalizePrincipalName } from "../auth/organization-login";
import { registrationChallenge, verifyPasskeyRegistration, type PasskeyRegistration } from "../provider-adapters/implementations/luxia-local/webauthn-registration";

// Customer Self-Onboarding v1, steps 3 and 4 (requirements 1, 5, 6, 7). A private-beta code lets
// a company create its organization and its first administrator. Begin reserves the code and stores
// the request on the code row, without creating anything. Complete runs ONE transaction: consume the
// code, create the organization, tenant, local connection, founder, identity, passkey and the
// administrator access from the server catalog, plus the audit trail. Any failure leaves nothing.

export class SignupError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "SIGNUP_CODE_INVALID" | "ORGANIZATION_SLUG_UNAVAILABLE" | "PASSKEY_REGISTRATION_INVALID", readonly status: number) { super(code); }
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
/** Codes are compared on letters and digits only, upper-cased: "luxia-abcd 1234" equals "LUXIA-ABCD-1234". */
export function signupCodeHash(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const canonical = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return canonical.length >= 16 && canonical.length <= 64 ? sha256Hex(canonical) : null;
}
const name = (value: unknown) => typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 120 ? value.trim() : null;

export type SignupRequest = { code: unknown; organizationName: unknown; organization: unknown; founderName: unknown; principalName: unknown };

export async function beginSignup(input: SignupRequest, rpId: string) {
  const codeHash = signupCodeHash(input.code);
  const payload = {
    organizationName: name(input.organizationName),
    slug: normalizeOrganizationSlug(input.organization),
    founderName: name(input.founderName),
    principalName: normalizePrincipalName(input.principalName),
  };
  if (!codeHash || !payload.organizationName || !payload.slug || !payload.founderName || !payload.principalName || payload.principalName.length < 3)
    throw new SignupError("INVALID_REQUEST", 400);
  const challenge = randomBytes(32).toString("base64url");
  const reserved = await rawPrisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT luxia_signup_reserve(${codeHash}, ${sha256Hex(challenge)}, ${JSON.stringify(payload)}::jsonb, ${600}::int) AS ok`;
  if (reserved[0]?.ok !== true) throw new SignupError("SIGNUP_CODE_INVALID", 403);
  // Only a valid code holder learns whether an identifier is taken.
  if (await rawPrisma.organization.findUnique({ where: { slug: payload.slug }, select: { id: true } }))
    throw new SignupError("ORGANIZATION_SLUG_UNAVAILABLE", 409);
  return {
    challenge,
    rp: { id: rpId, name: "LUXIA Identity" },
    user: { id: randomBytes(16).toString("base64url"), name: payload.principalName, displayName: payload.founderName },
  };
}

type Consumed = { signup_code_id: string; organization_id: string; payload: { organizationName: string; slug: string; founderName: string; principalName: string } };

export async function completeSignup(input: { code: unknown } & PasskeyRegistration, origin: { rpId: string; origin: string }) {
  const codeHash = signupCodeHash(input.code);
  const challenge = typeof input.clientDataJSON === "string" ? registrationChallenge(input.clientDataJSON) : null;
  if (!codeHash || !challenge) throw new SignupError("INVALID_REQUEST", 400);
  let passkey: { credentialId: string; publicKeyPem: string };
  try {
    passkey = verifyPasskeyRegistration({ ...input, expectedChallenge: challenge, expectedOrigin: origin.origin, rpId: origin.rpId });
  } catch {
    throw new SignupError("PASSKEY_REGISTRATION_INVALID", 400);
  }
  try {
    return await rawPrisma.$transaction(async (tx) => {
      // 1. The code must be reserved for exactly this challenge and still valid. It creates the
      //    organization from the payload stored at begin; the browser cannot change it now.
      const rows = await tx.$queryRaw<Consumed[]>`SELECT * FROM luxia_signup_consume(${codeHash}, ${sha256Hex(challenge)})`;
      if (rows.length !== 1) throw new SignupError("SIGNUP_CODE_INVALID", 403);
      const { signup_code_id: signupCodeId, organization_id: organizationId, payload } = rows[0];
      const tenantId = randomUUID();
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      await tx.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const context = { organizationId, tenantId };

      // 2. Sign-in method of the new organization and its founder.
      const connection = await tx.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", status: "ACTIVE", externalScopeId: tenantId, name: "LUXIA Local" } });
      await tx.providerConnectionTenantScope.create({ data: { ...context, providerConnectionId: connection.id } });
      const founder = await tx.subject.create({ data: { ...context, type: "HUMAN", name: payload.founderName } });
      await createPasskeyIdentity(tx, context, { subjectId: founder.id, connectionId: connection.id, principalName: payload.principalName,
        passkey, rpId: origin.rpId, origin: origin.origin, actorSubjectId: founder.id });

      // 3. First administrator: entitlement keys come only from the server catalog (requirement 7).
      await grantAdministrator(tx, context, { subjectId: founder.id, actorSubjectId: founder.id, changePrefix: `signup:${signupCodeId}`, metadata: { firstAdmin: true } });

      // 4. Audit, in the same transaction. No code, challenge or key material.
      await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: founder.id, targetSubjectId: founder.id,
        operation: "ORGANIZATION.CREATE", changeId: `signup:${signupCodeId}:organization`, result: "SUCCESS", metadata: { signupCodeId, slug: payload.slug } } });
      return { organization: payload.slug };
    }, { maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof SignupError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || (error.code === "P2010" && (error.meta as { code?: string } | undefined)?.code === "23505")))
      throw new SignupError("ORGANIZATION_SLUG_UNAVAILABLE", 409);
    throw error;
  }
}
