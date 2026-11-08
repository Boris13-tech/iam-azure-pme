"use client";

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

const STORAGE_KEY = "luxia.organization";
const INPUT = "lx-input";
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
    <form onSubmit={submit} className="lx-stack">
      <div className="lx-field">
        <label htmlFor="recovery-organization" className="lx-label">Identifiant de l’organisation</label>
        <input id="recovery-organization" value={organization} onChange={e => setOrganization(e.target.value)} required autoComplete="organization"
          autoCapitalize="none" spellCheck={false} className={INPUT} />
      </div>
      <div className="lx-field">
        <label htmlFor="recovery-principal" className="lx-label">Votre identifiant</label>
        <input id="recovery-principal" value={principalName} onChange={e => setPrincipalName(e.target.value)} required maxLength={254}
          autoComplete="username" autoCapitalize="none" spellCheck={false} className={INPUT} />
      </div>
      <div className="lx-field">
        <label htmlFor="recovery-code" className="lx-label">Code de récupération</label>
        <input id="recovery-code" value={code} onChange={e => setCode(e.target.value)} required maxLength={64} autoComplete="one-time-code"
          autoCapitalize="characters" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" className="lx-input lx-input--mono" />
      </div>
      {message && <p className="lx-alert lx-alert--danger m-0" role="alert">{message}</p>}
      <button type="submit" disabled={busy || !organization || !principalName || !code}
        className="lx-btn lx-btn--primary">
        <KeyRound size={20} aria-hidden />
        {busy ? "Vérification..." : "Utiliser ce code"}
      </button>
    </form>
  );
}
