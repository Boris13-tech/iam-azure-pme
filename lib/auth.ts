import { ConfidentialClientApplication, Configuration, LogLevel } from "@azure/msal-node";

export const msalConfig: Configuration = {
    auth: {
    clientId: process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID || "dummy_client_id",
    authority: "https://login.microsoftonline.com/" + (process.env.GRAPH_TENANT_ID || process.env.NEXT_PUBLIC_GRAPH_TENANT_ID || "dummy_tenant_id"),
    // Evite le crash au moment du build sur Vercel si la variable est manquante
    clientSecret: process.env.GRAPH_CLIENT_SECRET || "dummy_secret_to_prevent_build_crash",
  },
  system: {
    loggerOptions: {
      loggerCallback(loglevel, message, containsPii) {
        if (!containsPii) console.log(message);
      },
      piiLoggingEnabled: false,
      logLevel: LogLevel.Warning,
    },
  },
};

export const cca = new ConfidentialClientApplication(msalConfig);

export const getAccessTokenPushed = async (scopes: string[]) => {
  try {
    const result = await cca.acquireTokenByClientCredential({
      scopes,
    });
    return result?.accessToken;
  } catch (error) {
    console.error("Error acquiring access token", error);
    return null;
  }
};
