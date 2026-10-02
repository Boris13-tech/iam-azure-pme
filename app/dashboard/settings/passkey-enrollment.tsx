"use client";

import { useState } from "react";
import { Fingerprint, CheckCircle2 } from "lucide-react";

const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function PasskeyEnrollment() {
  const [principalName, setPrincipalName] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
  async function enroll() {
    try {
      setStatus("busy");
      const beginResponse = await fetch("/api/auth/local/enrollment/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalName }) });
      if (!beginResponse.ok) throw new Error();
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
      if (!publicKey) throw new Error();
      const completed = await fetch("/api/auth/local/enrollment/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        providerConnectionId: begin.providerConnectionId, identityAccountId: begin.identityAccountId,
        transactionId: begin.transactionId, challenge: begin.challenge,
        credentialId: encode(credential.rawId), publicKey: encode(publicKey),
      }) });
      if (!completed.ok) throw new Error();
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }
  return <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
    <div className="flex items-start gap-4">
      <div className="rounded-xl bg-emerald-100 p-3 text-emerald-700"><Fingerprint className="h-7 w-7" /></div>
      <div className="flex-1">
        <h3 className="font-bold text-slate-900">LUXIA_LOCAL — Passkey biométrique</h3>
        <p className="mt-1 text-sm text-slate-600">Ajoutez Windows Hello, Touch ID ou le verrouillage biométrique de votre appareil. La biométrie reste dans l’appareil ; LUXIA conserve uniquement la clé publique.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input value={principalName} onChange={e => setPrincipalName(e.target.value)} className="flex-1 rounded-xl border border-emerald-200 bg-white px-4 py-3" placeholder="Identifiant local (ex. contact@entreprise.com)" />
          <button onClick={enroll} disabled={!principalName || status === "busy"} className="rounded-xl bg-emerald-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{status === "busy" ? "Enrôlement…" : "Ajouter une passkey"}</button>
        </div>
        {status === "done" && <p className="mt-3 flex items-center gap-2 text-sm font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Passkey activée.</p>}
        {status === "error" && <p className="mt-3 text-sm font-semibold text-red-700">L’enrôlement a échoué sans modifier vos accès existants.</p>}
      </div>
    </div>
  </section>;
}
