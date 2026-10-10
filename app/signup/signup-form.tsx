"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Fingerprint } from "lucide-react";

const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const MESSAGES: Record<string, string> = {
  INVALID_REQUEST: "Vérifiez les champs. L’identifiant d’organisation contient de 3 à 40 caractères : lettres minuscules, chiffres et tirets.",
  SIGNUP_CODE_INVALID: "Ce code n’est pas valide, a expiré ou a déjà été utilisé.",
  ORGANIZATION_SLUG_UNAVAILABLE: "Cet identifiant d’organisation est déjà utilisé. Choisissez-en un autre.",
  PASSKEY_REGISTRATION_INVALID: "La clé d’accès n’a pas pu être enregistrée. Réessayez.",
  RATE_LIMITED: "Trop de tentatives. Réessayez plus tard.",
};
const UNAVAILABLE = "Le service est temporairement indisponible. Réessayez dans quelques minutes.";

/** Suggestion only: lower case, no accents, words joined by hyphens. */
function suggestSlug(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

class Refused extends Error { constructor(readonly code: string) { super(code); } }

export function SignupForm() {
  const [form, setForm] = useState({ code: "", organizationName: "", organization: "", founderName: "", principalName: "" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [status, setStatus] = useState<"idle" | "busy" | "done">("idle");
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState("");

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setForm(current => ({ ...current, [key]: value, ...(key === "organizationName" && !slugTouched ? { organization: suggestSlug(value) } : {}) }));
    if (key === "organization") setSlugTouched(true);
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
        setMessage("Ce navigateur ne prend pas en charge les clés d’accès. Utilisez Microsoft Edge ou Google Chrome.");
        return;
      }
      setStatus("busy");
      const begin = await fetch("/api/auth/signup/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
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
      const complete = await fetch("/api/auth/signup/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        code: form.code, credentialId: encode(credential.rawId), clientDataJSON: encode(response.clientDataJSON),
        authenticatorData: encode(authenticatorData), publicKey: encode(publicKey),
      }) });
      if (!complete.ok) throw new Refused((await complete.json().catch(() => ({}))).error ?? "");
      const result = await complete.json();
      try { window.localStorage.setItem("luxia.organization", result.organization); } catch { /* storage unavailable */ }
      setCreated(result.organization);
      setStatus("done");
    } catch (error) {
      setStatus("idle");
      if (error instanceof DOMException && error.name === "NotAllowedError") setMessage("La création de la clé d’accès a été annulée ou a expiré. Vous pouvez réessayer.");
      else setMessage(error instanceof Refused ? MESSAGES[error.code] ?? UNAVAILABLE : UNAVAILABLE);
    }
  }

  if (status === "done") return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-base font-medium text-green-700"><CheckCircle2 className="h-5 w-5" aria-hidden /> Organisation créée.</p>
      <p className="text-base text-slate-700">Votre identifiant d’organisation est <span className="font-mono font-semibold">{created}</span>. Connectez-vous maintenant avec votre clé d’accès.</p>
      <Link href={`/login?org=${encodeURIComponent(created)}`} className="flex w-full items-center justify-center rounded-md bg-[#1f5fbf] px-4 py-2.5 text-base font-medium text-white hover:bg-[#194e9e]">Se connecter</Link>
    </div>
  );

  const field = (key: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1.5">
      <label htmlFor={`signup-${key}`} className="block text-sm font-medium text-slate-700">{label}</label>
      <input id={`signup-${key}`} value={form[key]} onChange={set(key)} required
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:border-[#1f5fbf] focus:outline-none focus:ring-2 focus:ring-[#eaf1fb]" {...props} />
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {field("code", "Code d’accès bêta", { autoComplete: "off", spellCheck: false, placeholder: "LUXIA-XXXX-XXXX-XXXX-XXXX" })}
      {field("organizationName", "Nom de l’organisation", { autoComplete: "organization", maxLength: 120 })}
      {field("organization", "Identifiant de l’organisation", { autoCapitalize: "none", spellCheck: false, maxLength: 40, placeholder: "par exemple mon-entreprise" })}
      <p className="text-sm text-slate-600">Il sert à la connexion de votre équipe et ne pourra pas être modifié.</p>
      {field("founderName", "Votre nom", { autoComplete: "name", maxLength: 120 })}
      {field("principalName", "Votre identifiant", { autoComplete: "username", autoCapitalize: "none", maxLength: 254, placeholder: "prenom.nom@entreprise.com" })}
      {message && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{message}</p>}
      <button type="submit" disabled={status === "busy"} className="flex w-full items-center justify-center gap-2 rounded-md bg-[#1f5fbf] px-4 py-2.5 text-base font-medium text-white hover:bg-[#194e9e] disabled:opacity-50">
        <Fingerprint className="h-5 w-5" aria-hidden />
        {status === "busy" ? "Création en cours..." : "Créer l’organisation et ma clé d’accès"}
      </button>
      <p className="text-sm text-slate-600">Vous serez le premier administrateur de l’organisation. Votre clé d’accès reste sur votre appareil.</p>
    </form>
  );
}
