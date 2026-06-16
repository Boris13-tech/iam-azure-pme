import { ConfidentialClientApplication, Configuration, LogLevel } from "@azure/msal-node";


export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_AZURE_AD_B2C_CLIENT_ID || "",
    authority: process.env.NEXT_PUBLIC_AZURE_AD_B2C_AUTHORITY || "",
    knownAuthorities: [process.env.NEXT_PUBLIC_AZURE_AD_B2C_TENANT_NAME + ".b2clogin.com"],
    clientSecret: process.env.AZURE_AD_B2C_CLIENT_SECRET || "",
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

