"use client";

import { useState } from "react";
import Link from "next/link";
import { Fingerprint } from "lucide-react";

const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

class SignInRefused extends Error { constructor(readonly status: number) { super("SIGN_IN_REFUSED"); } }

// The browser sends only the organization identifier and the person's identifier. The server
// resolves the organization, tenant and connection itself and answers the same way whether or
// not they exist.
export function LocalPasskeyLogin({ organization, onBeforeSignIn }: { organization: string; onBeforeSignIn: () => boolean }) {
  const [principalName, setPrincipalName] = useState("");
  const [status, setStatus] = useState("");
  async function login() {
    if (!onBeforeSignIn()) return;
    try {
      setStatus("Vérification de la clé d’accès...");
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
        setStatus("Ce navigateur ne prend pas en charge les clés d’accès. Utilisez Edge ou Chrome.");
        return;
      }
      const begin = await fetch("/api/auth/local/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organization, principalName }) });
      if (!begin.ok) throw new SignInRefused(begin.status);
      const challenge = await begin.json();
      const credential = await navigator.credentials.get({ publicKey: {
        challenge: decode(challenge.challenge), rpId: challenge.rpId,
        allowCredentials: challenge.allowCredentials.map((id: string) => ({ id: decode(id), type: "public-key" as const })),
        userVerification: "required", timeout: 120000,
      } }) as PublicKeyCredential | null;
      if (!credential) throw new SignInRefused(401);
      const assertion = credential.response as AuthenticatorAssertionResponse;
      const complete = await fetch("/api/auth/local/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        organization, transactionId: challenge.transactionId, challenge: challenge.challenge,
        credentialId: encode(credential.rawId), clientDataJSON: encode(assertion.clientDataJSON),
        authenticatorData: encode(assertion.authenticatorData), signature: encode(assertion.signature),
      }) });
      if (!complete.ok) throw new SignInRefused(complete.status);
      window.location.assign("/dashboard");
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") setStatus("La vérification a été annulée, a expiré, ou aucune clé d’accès ne correspond.");
      else if (error instanceof SignInRefused && error.status === 429) setStatus("Trop de tentatives. Réessayez dans quelques minutes.");
      else if (error instanceof SignInRefused && error.status === 400) setStatus("Vérifiez l’identifiant de l’organisation et votre identifiant.");
      else setStatus("Connexion refusée. Vérifiez l’identifiant de l’organisation et votre identifiant.");
    }
  }
  return <div className="lx-stack">
    <div className="lx-field">
      <label htmlFor="luxia-principal" className="lx-label">Votre identifiant</label>
      <input id="luxia-principal" value={principalName} onChange={e => setPrincipalName(e.target.value)} autoComplete="username webauthn" className="lx-input" placeholder="Votre identifiant" />
    </div>
    <button onClick={login} disabled={!principalName || !organization} className="lx-btn lx-btn--primary">
      <Fingerprint size={20} aria-hidden /> Se connecter avec une clé d’accès
    </button>
    {status && <p className="lx-status" role="status">{status}</p>}
    <p className="lx-status"><Link href="/login/recovery" className="lx-link">J’ai perdu ma clé d’accès</Link></p>
  </div>;
}
