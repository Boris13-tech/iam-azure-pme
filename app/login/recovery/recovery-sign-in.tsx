"use client";

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

const STORAGE_KEY = "luxia.organization";
const INPUT = "w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:border-[#1f5fbf] focus:outline-none focus:ring-2 focus:ring-[#eaf1fb]";
// One message for every refusal: the server never says which part was wrong.
const REFUSED = "Connexion refusée. Vérifiez l’identifiant de l’organisation, votre identifiant et le code. Après plusieurs essais, patientez une heure.";

export function RecoverySignIn() {
  const [organization, setOrganization] = useState("");
  const [principalName, setPrincipalName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    try { setOrganization(window.localStorage.getItem(STORAGE_KEY) ?? ""); } catch { /* storage unavailable */ }
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/local/recovery", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization: organization.trim().toLowerCase(), principalName, code }) });
      if (!response.ok) throw new Error();
      setCode("");
      window.location.assign("/recovery");
    } catch {
      setMessage(REFUSED);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="recovery-organization" className="block text-sm font-medium text-slate-700">Identifiant de l’organisation</label>
        <input id="recovery-organization" value={organization} onChange={e => setOrganization(e.target.value)} required autoComplete="organization"
          autoCapitalize="none" spellCheck={false} className={INPUT} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="recovery-principal" className="block text-sm font-medium text-slate-700">Votre identifiant</label>
        <input id="recovery-principal" value={principalName} onChange={e => setPrincipalName(e.target.value)} required maxLength={254}
          autoComplete="username" autoCapitalize="none" spellCheck={false} className={INPUT} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="recovery-code" className="block text-sm font-medium text-slate-700">Code de récupération</label>
        <input id="recovery-code" value={code} onChange={e => setCode(e.target.value)} required maxLength={64} autoComplete="one-time-code"
          autoCapitalize="characters" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" className={`${INPUT} font-mono tracking-wide`} />
      </div>
      {message && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{message}</p>}
      <button type="submit" disabled={busy || !organization || !principalName || !code}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-[#1f5fbf] px-4 py-2.5 text-base font-medium text-white hover:bg-[#194e9e] disabled:opacity-50">
        <KeyRound className="h-5 w-5" aria-hidden />
        {busy ? "Vérification..." : "Utiliser ce code"}
      </button>
    </form>
  );
}
