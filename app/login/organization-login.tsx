"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
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
    <div className="space-y-6">
      <div className="space-y-2">
        <label htmlFor="luxia-organization" className="block text-sm font-medium text-slate-700">Identifiant de l’organisation</label>
        <input id="luxia-organization" value={organization} onChange={e => setOrganization(e.target.value)} autoComplete="organization"
          autoCapitalize="none" spellCheck={false} placeholder="par exemple legrand-tech"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:border-[#1f5fbf] focus:outline-none focus:ring-2 focus:ring-[#eaf1fb]" />
        {hint && <p className="text-sm text-red-700" role="alert">{hint}</p>}
      </div>
      <form action="/auth/login" method="get" onSubmit={e => { if (!ready()) e.preventDefault(); }}>
        <input type="hidden" name="org" value={slug} />
        <button type="submit" disabled={!slug}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[#1f5fbf] px-4 py-2.5 text-base font-medium text-white hover:bg-[#194e9e] disabled:opacity-50">
          <Lock className="h-5 w-5" aria-hidden />
          Se connecter avec Microsoft
        </button>
      </form>
      <LocalPasskeyLogin organization={slug} onBeforeSignIn={ready} />
    </div>
  );
}
