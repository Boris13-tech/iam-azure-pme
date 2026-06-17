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
import { prisma } from "./prisma";

export const syncAzureUsers = async () => {
  try {
    const client = await getGraphClient();
    const result = await client.api('/users')
      .select('id,displayName,mail,userPrincipalName,accountEnabled')
      .get();
    
    const graphUsers = result.value || [];
    const graphUserIds = new Set();
    
    for (const graphUser of graphUsers) {
      const email = (graphUser.mail || graphUser.userPrincipalName || "").toLowerCase();
      if (!email) continue;

      const azureId = graphUser.id;
      graphUserIds.add(azureId);
      const name = graphUser.displayName || email.split('@')[0];
      const isActive = graphUser.accountEnabled !== false;

      // Find user by azureId or email
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { azureId: azureId },
            { email: email }
          ]
        }
      });

      if (existingUser) {
        // Update user
        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            azureId: azureId,
            name: name,
            email: email,
            status: isActive ? "ACTIVE" : "INACTIVE"
          }
        });

        // Ensure user has at least one role
        const rolesCount = await prisma.userRole.count({
          where: { userId: existingUser.id }
        });
        if (rolesCount === 0) {
          await prisma.userRole.create({
            data: {
              userId: existingUser.id,
              roleId: "user-id"
            }
          });
        }
      } else {
        // Create user
        const newUser = await prisma.user.create({
          data: {
            azureId: azureId,
            name: name,
            email: email,
            status: isActive ? "ACTIVE" : "INACTIVE"
          }
        });

        // Assign default role (Utilisateur Standard)
        await prisma.userRole.create({
          data: {
            userId: newUser.id,
            roleId: "user-id"
          }
        });
      }
    }
    
    // Deactivate local users that were deleted from Azure AD
    const localAzureUsers = await prisma.user.findMany({
      where: {
        azureId: { not: null }
      }
    });

    for (const localUser of localAzureUsers) {
      if (localUser.azureId && !graphUserIds.has(localUser.azureId)) {
        await prisma.user.update({
          where: { id: localUser.id },
          data: { status: "INACTIVE" }
        });
      }
    }
  } catch (error) {
    console.error("Error during Azure AD user sync:", error)
  }
};

export const createAzureUser = async (name: string, email: string) => {
  const client = await getGraphClient();

  // Get primary domain
  let defaultDomain = "onmicrosoft.com";
  try {
    const domains = await client.api('/domains').get();
    const primaryDomain = domains.value.find((d: any) => d.isDefault || d.isInitial)?.id;
    if (primaryDomain) defaultDomain = primaryDomain;
  } catch (e) {
    console.warn("Could not fetch tenant domains, using default:", e);
  }

  // Format UPN
  const emailDomain = email.split('@')[1];
  let upn = email;
  const genericDomains = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com"];
  if (genericDomains.includes(emailDomain.toLowerCase())) {
    const localPart = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
    upn = `${localPart}@${defaultDomain}`;
  }

  const tempPassword = "Temp" + Math.random().toString(36).substring(2, 10) + "1!";

  const msalUser = {
    accountEnabled: true,
    displayName: name,
    mailNickname: email.split('@')[0].replace(/[^a-zA-Z0-9]/g, ''),
    userPrincipalName: upn,
    mail: email,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: tempPassword
    }
  };

  const createdUser = await client.api('/users').post(msalUser);
  return {
    azureId: createdUser.id,
    upn: createdUser.userPrincipalName,
    tempPassword
  };
};

export const updateAzureUserStatus = async (azureId: string, isActive: boolean) => {
  try {
    const client = await getGraphClient();
    await client.api(`/users/${azureId}`).update({
      accountEnabled: isActive
    });
  } catch (error) {
    console.error(`Failed to update Azure user status for ${azureId}:`, error);
  }
};

export const updateAzureUser = async (azureId: string, name?: string, email?: string) => {
  try {
    const client = await getGraphClient();
    const updateData: any = {};
    if (name) updateData.displayName = name;
    if (email) updateData.mail = email;
    
    await client.api(`/users/${azureId}`).update(updateData);
  } catch (error) {
    console.error(`Failed to update Azure user ${azureId}:`, error);
  }
};
