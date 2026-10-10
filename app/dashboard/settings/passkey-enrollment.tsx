"use client";

import { useState } from "react";
import { Fingerprint, CheckCircle2 } from "lucide-react";

const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function PasskeyEnrollment() {
  const [principalName, setPrincipalName] = useState("");
  const [status, setStatus] = useState<string>("idle");
  async function enroll() {
    try {
      setStatus("busy");
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
        throw new Error("WEBAUTHN_UNAVAILABLE");
      }
      const beginResponse = await fetch("/api/auth/local/enrollment/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalName }) });
      if (!beginResponse.ok) {
        const failure = await beginResponse.json().catch(() => ({ error: "ENROLLMENT_BEGIN_FAILED" }));
        throw new Error(`SERVER_BEGIN:${failure.error ?? "ENROLLMENT_BEGIN_FAILED"}`);
      }
      const begin = await beginResponse.json();
      const credential = await navigator.credentials.create({ publicKey: {
        challenge: decode(begin.challenge), rp: begin.rp,
        user: { id: new TextEncoder().encode(begin.user.id), name: begin.user.name, displayName: begin.user.displayName },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
        timeout: 120000, attestation: "none",
      } }) as PublicKeyCredential | null;
      if (!credential) throw new Error();
      const attestation = credential.response as AuthenticatorAttestationResponse;
      const publicKey = attestation.getPublicKey?.();
      if (!publicKey) throw new Error("PUBLIC_KEY_UNAVAILABLE");
      const completed = await fetch("/api/auth/local/enrollment/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        providerConnectionId: begin.providerConnectionId, identityAccountId: begin.identityAccountId,
        transactionId: begin.transactionId, challenge: begin.challenge,
        credentialId: encode(credential.rawId), publicKey: encode(publicKey),
      }) });
      if (!completed.ok) {
        const failure = await completed.json().catch(() => ({ error: "ENROLLMENT_COMPLETE_FAILED" }));
        throw new Error(`SERVER_COMPLETE:${failure.error ?? "ENROLLMENT_COMPLETE_FAILED"}`);
      }
      setStatus("done");
    } catch (error) {
      if (error instanceof Error && error.message === "WEBAUTHN_UNAVAILABLE") {
        setStatus("unsupported");
      } else if (error instanceof DOMException && error.name === "NotAllowedError") {
        setStatus("cancelled");
      } else {
        const code = error instanceof Error ? `${error.name}:${error.message}` : "UNKNOWN";
        setStatus(`error:${code}`);
      }
    }
  }
  return <section className="rounded-lg border border-slate-200 bg-white p-5">
    <div className="flex items-start gap-4">
      <div className="rounded-md bg-accent-soft p-2.5 text-accent"><Fingerprint className="h-6 w-6" aria-hidden /></div>
      <div className="flex-1">
        <h2 className="text-base font-semibold text-slate-900">Clé d’accès</h2>
        <p className="mt-1 text-sm text-slate-600">Utilisez Windows Hello, Touch ID ou le déverrouillage de votre appareil pour vous connecter. Vos données biométriques restent sur l’appareil.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input value={principalName} onChange={e => setPrincipalName(e.target.value)} className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base" placeholder="Votre identifiant, par exemple prenom.nom@entreprise.com" />
          <button onClick={enroll} disabled={!principalName || status === "busy"} className="rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong disabled:opacity-50">{status === "busy" ? "Enregistrement..." : "Ajouter une clé d’accès"}</button>
        </div>
        {status === "done" && <p className="mt-3 flex items-center gap-2 text-sm font-medium text-green-700"><CheckCircle2 className="h-4 w-4" aria-hidden /> Clé d’accès enregistrée.</p>}
        {status === "unsupported" && <p className="mt-3 text-sm font-semibold text-amber-800">Ce navigateur ne prend pas en charge les clés d’accès. Utilisez Microsoft Edge ou Google Chrome.</p>}
        {status === "cancelled" && <p className="mt-3 text-sm font-semibold text-amber-800">La confirmation a été annulée ou a expiré. Vous pouvez réessayer.</p>}
        {status.startsWith("error:") && <p className="mt-3 text-sm font-semibold text-red-700">L’enregistrement a échoué. Vos accès n’ont pas été modifiés. Code : <span className="font-mono">{status.slice(6)}</span></p>}
      </div>
    </div>
  </section>;
}
