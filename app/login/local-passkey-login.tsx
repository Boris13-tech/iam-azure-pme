"use client";

import { useState } from "react";
import { Fingerprint } from "lucide-react";

const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function LocalPasskeyLogin({ providerConnectionId, tenantId }: { providerConnectionId: string; tenantId: string }) {
  const [principalName, setPrincipalName] = useState("");
  const [status, setStatus] = useState("");
  async function login() {
    try {
      setStatus("Vérification de la passkey…");
      const begin = await fetch("/api/auth/local/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalName, providerConnectionId, tenantId }) });
      if (!begin.ok) throw new Error();
      const challenge = await begin.json();
      const credential = await navigator.credentials.get({ publicKey: {
        challenge: decode(challenge.challenge), rpId: challenge.rpId,
        allowCredentials: challenge.allowCredentials.map((id: string) => ({ id: decode(id), type: "public-key" as const })),
        userVerification: "required", timeout: 120000,
      } }) as PublicKeyCredential | null;
      if (!credential) throw new Error();
      const assertion = credential.response as AuthenticatorAssertionResponse;
      const complete = await fetch("/api/auth/local/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        providerConnectionId, tenantId, transactionId: challenge.transactionId, challenge: challenge.challenge,
        externalObjectId: challenge.externalObjectId, credentialId: encode(credential.rawId), clientDataJSON: encode(assertion.clientDataJSON),
        authenticatorData: encode(assertion.authenticatorData), signature: encode(assertion.signature),
      }) });
      if (!complete.ok) throw new Error();
      window.location.assign("/dashboard");
    } catch {
      setStatus("Connexion locale refusée. Vérifiez l’identifiant et la passkey.");
    }
  }
  return <div className="space-y-3 border-t border-slate-700 pt-5">
    <label className="block text-sm font-medium text-slate-300">Identifiant local LUXIA</label>
    <input value={principalName} onChange={e => setPrincipalName(e.target.value)} autoComplete="username webauthn" className="w-full rounded-xl border border-slate-600 bg-slate-900/70 px-4 py-3 text-white" placeholder="votre identifiant local" />
    <button onClick={login} disabled={!principalName} className="w-full flex items-center justify-center gap-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold py-3.5 px-6 rounded-xl">
      <Fingerprint className="w-5 h-5" /> Connexion biométrique / passkey
    </button>
    {status && <p className="text-xs text-slate-300 text-center">{status}</p>}
  </div>;
}
