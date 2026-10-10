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
      setStatus("Vérification de la clé d’accès...");
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
        setStatus("Ce navigateur ne prend pas en charge Windows Hello/WebAuthn. Utilisez Edge ou Chrome.");
        return;
      }
      const begin = await fetch("/api/auth/local/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalName, providerConnectionId, tenantId }) });
      if (!begin.ok) {
        const failure = await begin.json().catch(() => ({ error: "AUTH_BEGIN_FAILED" }));
        throw new Error(`SERVER_BEGIN:${failure.error ?? "AUTH_BEGIN_FAILED"}`);
      }
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
      if (!complete.ok) {
        const failure = await complete.json().catch(() => ({ error: "AUTH_COMPLETE_FAILED" }));
        throw new Error(`SERVER_COMPLETE:${failure.error ?? "AUTH_COMPLETE_FAILED"}`);
      }
      window.location.assign("/dashboard");
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === "NotAllowedError"
        ? "La vérification biométrique a été annulée ou a expiré."
        : `Connexion refusée. Code : ${error instanceof Error ? `${error.name}:${error.message}` : "UNKNOWN"}`);
    }
  }
  return <div className="space-y-3 border-t border-slate-200 pt-5">
    <label htmlFor="luxia-principal" className="block text-sm font-medium text-slate-700">Identifiant LUXIA</label>
    <input id="luxia-principal" value={principalName} onChange={e => setPrincipalName(e.target.value)} autoComplete="username webauthn" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:border-[#1f5fbf] focus:outline-none focus:ring-2 focus:ring-[#eaf1fb]" placeholder="Votre identifiant" />
    <button onClick={login} disabled={!principalName} className="w-full flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-base font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50">
      <Fingerprint className="w-5 h-5" aria-hidden /> Se connecter avec une clé d’accès
    </button>
    {status && <p className="text-sm text-slate-600 text-center">{status}</p>}
  </div>;
}
