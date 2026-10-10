"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Fingerprint } from "lucide-react";

const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const MESSAGES: Record<string, string> = {
  INVITATION_INVALID: "Ce lien d’invitation n’est pas valide, a expiré, a été révoqué ou a déjà été utilisé. Demandez un nouveau lien à votre administrateur.",
  IDENTIFIER_UNAVAILABLE: "Cet identifiant est déjà utilisé dans l’organisation. Choisissez-en un autre.",
  INVALID_REQUEST: "Votre identifiant doit contenir au moins 3 caractères.",
  PASSKEY_REGISTRATION_INVALID: "La clé d’accès n’a pas pu être enregistrée. Réessayez.",
  RATE_LIMITED: "Trop de tentatives. Réessayez plus tard.",
};
const UNAVAILABLE = "Le service est temporairement indisponible. Réessayez dans quelques minutes.";
class Refused extends Error { constructor(readonly code: string) { super(code); } }

export function AcceptInvitation() {
  const [token, setToken] = useState<string | null>(null);
  const [principalName, setPrincipalName] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "done">("idle");
  const [message, setMessage] = useState("");
  const [organization, setOrganization] = useState("");

  // The token is in the URL fragment (never sent to a server). Keep it in memory and remove it from the address bar.
  useEffect(() => {
    const value = window.location.hash.replace(/^#/, "");
    setToken(/^[A-Za-z0-9_-]{43}$/.test(value) ? value : "");
    if (value) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
        setMessage("Ce navigateur ne prend pas en charge les clés d’accès. Utilisez Microsoft Edge ou Google Chrome.");
        return;
      }
      setStatus("busy");
      const begin = await fetch("/api/auth/invitation/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, principalName }) });
      if (!begin.ok) throw new Refused((await begin.json().catch(() => ({}))).error ?? "");
      const options = await begin.json();
      const credential = await navigator.credentials.create({ publicKey: {
        challenge: decode(options.challenge), rp: options.rp,
        user: { id: decode(options.user.id), name: options.user.name, displayName: options.user.displayName },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: 120000, attestation: "none",
      } }) as PublicKeyCredential | null;
      if (!credential) throw new Refused("PASSKEY_REGISTRATION_INVALID");
      const response = credential.response as AuthenticatorAttestationResponse;
      const publicKey = response.getPublicKey?.();
      const authenticatorData = response.getAuthenticatorData?.();
      if (!publicKey || !authenticatorData) throw new Refused("PASSKEY_REGISTRATION_INVALID");
      const complete = await fetch("/api/auth/invitation/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        token, principalName, credentialId: encode(credential.rawId), clientDataJSON: encode(response.clientDataJSON),
        authenticatorData: encode(authenticatorData), publicKey: encode(publicKey),
      }) });
      if (!complete.ok) throw new Refused((await complete.json().catch(() => ({}))).error ?? "");
      const result = await complete.json();
      try { window.localStorage.setItem("luxia.organization", result.organization); } catch { /* storage unavailable */ }
      setOrganization(result.organization);
      setStatus("done");
    } catch (error) {
      setStatus("idle");
      if (error instanceof DOMException && error.name === "NotAllowedError") setMessage("La création de la clé d’accès a été annulée ou a expiré. Vous pouvez réessayer.");
      else setMessage(error instanceof Refused ? MESSAGES[error.code] ?? UNAVAILABLE : UNAVAILABLE);
    }
  }

  if (token === null) return null;
  if (!token) return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{MESSAGES.INVITATION_INVALID}</p>;
  if (status === "done") return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-base font-medium text-green-700"><CheckCircle2 className="h-5 w-5" aria-hidden /> Votre compte est activé.</p>
      <p className="text-base text-slate-700">Identifiant de l’organisation : <span className="font-mono font-semibold">{organization}</span>. Connectez-vous maintenant avec votre clé d’accès.</p>
      <Link href={`/login?org=${encodeURIComponent(organization)}`} className="flex w-full items-center justify-center rounded-md bg-[#1f5fbf] px-4 py-2.5 text-base font-medium text-white hover:bg-[#194e9e]">Se connecter</Link>
    </div>
  );
  return (
    <form onSubmit={accept} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="invitation-principal" className="block text-sm font-medium text-slate-700">Choisissez votre identifiant</label>
        <input id="invitation-principal" value={principalName} onChange={e => setPrincipalName(e.target.value)} required maxLength={254} autoComplete="username" autoCapitalize="none"
          placeholder="prenom.nom@entreprise.com" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:border-[#1f5fbf] focus:outline-none focus:ring-2 focus:ring-[#eaf1fb]" />
      </div>
      {message && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{message}</p>}
      <button type="submit" disabled={status === "busy" || !principalName} className="flex w-full items-center justify-center gap-2 rounded-md bg-[#1f5fbf] px-4 py-2.5 text-base font-medium text-white hover:bg-[#194e9e] disabled:opacity-50">
        <Fingerprint className="h-5 w-5" aria-hidden />
        {status === "busy" ? "Activation en cours..." : "Créer ma clé d’accès et rejoindre l’organisation"}
      </button>
      <p className="text-sm text-slate-600">Votre rôle et vos accès ont été définis par votre administrateur. Votre clé d’accès reste sur votre appareil.</p>
    </form>
  );
}
