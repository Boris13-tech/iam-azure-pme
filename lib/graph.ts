import { Client } from "@microsoft/microsoft-graph-client";
import "isomorphic-fetch";
import { cca } from "./auth";

export const getGraphClient = async () => {
  const tokenResponse = await cca.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });

  if (!tokenResponse?.accessToken) {
    throw new Error("Could not acquire Graph token");
  }

  return Client.init({
    authProvider: (done) => {
      done(null, tokenResponse.accessToken);
    },
  });
};