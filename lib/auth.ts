import { ConfidentialClientApplication, Configuration, LogLevel } from "@azure/msal-node";


export const msalConfig: Configuration = {
    auth: {
    clientId: process.env.GRAPH_CLIENT_ID || "",
    authority: "https://login.microsoftonline.com/" + process.env.GRAPH_TENANT_ID,
    clientSecret: process.env.GRAPH_CLIENT_SECRET || "",
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

