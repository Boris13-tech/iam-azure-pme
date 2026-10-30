"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Fingerprint } from "lucide-react";

const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const MESSAGES: Record<string, string> = {
  RECOVERY_SESSION_INVALID: "Votre session de récupération a expiré ou a déjà servi. Utilisez un autre code de récupération.",
  PASSKEY_REGISTRATION_INVALID: "La clé d’accès n’a pas pu être enregistrée. Réessayez.",
};
const UNAVAILABLE = "Le service est temporairement indisponible. Réessayez dans quelques minutes.";
class Refused extends Error { constructor(readonly code: string) { super(code); } }

export function RecoveryEnrollment() {
  const [status, setStatus] = useState<"idle" | "busy" | "done">("idle");
  const [message, setMessage] = useState("");

  async function enroll() {
    setMessage("");
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
        setMessage("Ce navigateur ne prend pas en charge les clés d’accès. Utilisez Microsoft Edge ou Google Chrome.");
        return;
      }
      setStatus("busy");
      const begin = await fetch("/api/auth/recovery/enrollment/begin", { method: "POST" });
      if (!begin.ok) throw new Refused((await begin.json().catch(() => ({}))).error ?? "");
      const options = await begin.json();
      const credential = await navigator.credentials.create({ publicKey: {
        challenge: decode(options.challenge), rp: options.rp,
        user: { id: decode(options.user.id), name: options.user.name, displayName: options.user.displayName },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: 120000, attestation: "none",
      } }) as PublicKeyCredential | null;
      if (!credential) throw new Refused("PASSKEY_REGISTRATION_INVALID");
      const response = credential.response as AuthenticatorAttestationResponse;
      const publicKey = response.getPublicKey?.();
      const authenticatorData = response.getAuthenticatorData?.();
      if (!publicKey || !authenticatorData) throw new Refused("PASSKEY_REGISTRATION_INVALID");
      const complete = await fetch("/api/auth/recovery/enrollment/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        transactionId: options.transactionId, credentialId: encode(credential.rawId), clientDataJSON: encode(response.clientDataJSON),
        authenticatorData: encode(authenticatorData), publicKey: encode(publicKey),
      }) });
      if (!complete.ok) throw new Refused((await complete.json().catch(() => ({}))).error ?? "");
      setStatus("done");
    } catch (error) {
      setStatus("idle");
      if (error instanceof DOMException && error.name === "NotAllowedError") setMessage("La création de la clé d’accès a été annulée ou a expiré. Vous pouvez réessayer.");
      else setMessage(error instanceof Refused ? MESSAGES[error.code] ?? UNAVAILABLE : UNAVAILABLE);
    }
  }

  if (status === "done") return (
    <div className="lx-stack">
      <p className="lx-alert lx-alert--success m-0" role="status"><CheckCircle2 size={18} className="flex-shrink-0" aria-hidden /> Votre nouvelle clé d’accès est enregistrée.</p>
      <p className="m-0 text-[15px] leading-relaxed text-[var(--text-secondary)]">La session de récupération est terminée. Connectez-vous maintenant avec votre nouvelle clé d’accès, puis générez un nouveau lot de codes de récupération.</p>
      <Link href="/login" className="lx-btn lx-btn--primary">Se connecter</Link>
    </div>
  );
  return (
    <div className="lx-stack">
      {message && <p className="lx-alert lx-alert--danger m-0" role="alert">{message}</p>}
      <button type="button" onClick={() => void enroll()} disabled={status === "busy"}
        className="lx-btn lx-btn--primary">
        <Fingerprint size={20} aria-hidden />
        {status === "busy" ? "Enregistrement..." : "Ajouter une nouvelle clé d’accès"}
      </button>
    </div>
  );
}
