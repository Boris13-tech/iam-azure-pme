import type { CDPSession, Page } from "@playwright/test";

// A Chrome virtual WebAuthn authenticator (DevTools Protocol), attached to one page: a platform
// passkey device (CTAP2, internal transport, discoverable credentials, user verification). The app
// runs its real ceremonies against it; nothing in the application is stubbed. It is software, not
// hardware: it proves the flows, and with an altered signature (05-refusals) the server's signature check; the
// server's user-verification check needs an assertion a browser never sends, and is proven at the route level
// (tests/resources/organization-login-postgres.test.ts). It never proves a hardware binding (attestation "none"),
// which stays a separate gate: a real Windows Hello, phone or security key sign-in on Production.

export type VirtualCredential = {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
};

export type VirtualAuthenticator = {
  readonly id: string;
  credentials(): Promise<VirtualCredential[]>;
  addCredential(credential: VirtualCredential): Promise<void>;
  clearCredentials(): Promise<void>;
  setUserVerified(verified: boolean): Promise<void>;
  remove(): Promise<void>;
};

const sessions = new WeakMap<Page, CDPSession>();
async function session(page: Page): Promise<CDPSession> {
  let cdp = sessions.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    // enableUI false: no browser dialog; the authenticator answers like a device whose user consented.
    await cdp.send("WebAuthn.enable", { enableUI: false });
    sessions.set(page, cdp);
  }
  return cdp;
}

export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await session(page);
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return {
    id: authenticatorId,
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials as VirtualCredential[],
    addCredential: async (credential) => { await cdp.send("WebAuthn.addCredential", { authenticatorId, credential }); },
    clearCredentials: async () => { await cdp.send("WebAuthn.clearCredentials", { authenticatorId }); },
    setUserVerified: async (isUserVerified) => { await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified }); },
    remove: async () => { await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }); },
  };
}
