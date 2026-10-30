import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Design v1: the official LUXIA-IT logo (luxia-it.com) is used as published, and every page before sign-in
// uses the same frame, which states only what is true in Production.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("Brand and the pages before sign-in", () => {
  it("the logo keeps the official geometry and colours of luxia-it.com", () => {
    const logo = read("components/brand/luxia-logo.tsx");
    expect(logo).toContain('viewBox="6.5 1 39 35"');
    expect(logo).toContain('points="23.6,8.4 32.2,8.4 44,34.6 34.6,34.6"');
    expect(logo).toContain('points="22,2 32.2,2 18.2,34.6 8,34.6"');
    for (const colour of ['"#1f5fbf"', '"#ffffff"', '"#8db3e8"']) expect(logo).toContain(colour);
    expect(logo).toContain("LUXIA-IT");
    const icon = read("app/icon.svg");
    expect(icon).toContain('points="22,2 32.2,2 18.2,34.6 8,34.6" fill="#1f5fbf"');
  });

  it("every page before sign-in uses the shared frame; none keeps the old standalone card", () => {
    for (const page of ["app/login/page.tsx", "app/signup/page.tsx", "app/login/recovery/page.tsx", "app/recovery/page.tsx", "app/invitation/page.tsx"]) {
      const source = read(page);
      expect(source, page).toContain("<AuthShell");
      expect(source, page).not.toMatch(/min-h-screen bg-\[#f7f8fa\]/);
    }
  });

  it("passkeys come first on the sign-in page; Microsoft stays available as the secondary method", () => {
    const login = read("app/login/organization-login.tsx");
    expect(login.indexOf("<LocalPasskeyLogin")).toBeLessThan(login.indexOf('action="/auth/login"'));
    expect(read("app/login/local-passkey-login.tsx")).toContain('className="lx-btn lx-btn--primary"');
    expect(login).toMatch(/className="lx-btn lx-btn--secondary">\s*<MicrosoftMark \/>\s*Continuer avec Microsoft/);
  });

  it("the brand panel makes no claim that is not true in Production today", () => {
    const shell = read("components/auth/auth-shell.tsx");
    // Production is not yet in the EU (EU-4 pending), certifications are not held, and the journal's owner could
    // still alter its guard: none of these may be claimed.
    expect(shell).not.toMatch(/\b(Europe|européen\w*|RGPD|GDPR)\b|certifi|personne ne peut|inviolable/i);
    expect(shell).not.toMatch(/\b(UE|EU|ISO|SOC ?2)\b/);
    expect(shell).toContain("bêta privée, sur invitation");
  });

  it("no font is downloaded: neither the build nor the browser depends on a font provider", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/next\/font/);
    expect(read("app/globals.css")).not.toMatch(/@import url\(|fonts\.googleapis/);
  });
});
