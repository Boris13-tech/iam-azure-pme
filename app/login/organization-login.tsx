"use client";

import { useEffect, useState } from "react";
import { LocalPasskeyLogin } from "./local-passkey-login";

const STORAGE_KEY = "luxia.organization";
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const normalize = (value: string) => value.trim().toLowerCase();

// The organization identifier is remembered in this browser only (a convenience, not a secret).
function remembered(): string {
  try { return window.localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
}
function remember(value: string) {
  try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* storage unavailable: nothing to do */ }
}

/** Microsoft's four squares, for the "sign in with Microsoft" button (Microsoft identity branding). */
function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

// Passkeys first (the pilots' method); Microsoft Entra stays available for organizations that use it.
export function OrganizationLogin({ initialOrganization }: { initialOrganization: string }) {
  const [organization, setOrganization] = useState(initialOrganization);
  const [hint, setHint] = useState("");
  useEffect(() => { if (!initialOrganization) setOrganization(remembered()); }, [initialOrganization]);

  const slug = normalize(organization);
  const ready = () => {
    if (!SLUG.test(slug) || slug.includes("--")) {
      setHint("L’identifiant d’organisation contient de 3 à 40 caractères : lettres minuscules, chiffres et tirets.");
      return false;
    }
    setHint("");
    remember(slug);
    return true;
  };

  return (
    <div className="lx-stack">
      <div className="lx-field">
        <label htmlFor="luxia-organization" className="lx-label">Identifiant de l’organisation</label>
        <input id="luxia-organization" value={organization} onChange={e => setOrganization(e.target.value)} autoComplete="organization"
          autoCapitalize="none" spellCheck={false} placeholder="par exemple legrand-tech" className="lx-input" />
        {hint && <p className="lx-error" role="alert">{hint}</p>}
      </div>
      <LocalPasskeyLogin organization={slug} onBeforeSignIn={ready} />
      <div className="lx-divider">ou</div>
      <form action="/auth/login" method="get" onSubmit={e => { if (!ready()) e.preventDefault(); }}>
        <input type="hidden" name="org" value={slug} />
        <button type="submit" disabled={!slug} className="lx-btn lx-btn--secondary">
          <MicrosoftMark />
          Continuer avec Microsoft
        </button>
      </form>
    </div>
  );
}
