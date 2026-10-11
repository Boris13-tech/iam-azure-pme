import React from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { RecoverySignIn } from "./recovery-sign-in";

export const dynamic = "force-dynamic";

// First Admin / Break-glass v1, B2: sign-in with a personal recovery code. The page reads nothing from
// the database and every refusal shows the same message.
export default function RecoveryLoginPage() {
  return (
    <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-8">
          <div className="mb-6 flex items-center gap-2 text-slate-900">
            <ShieldCheck className="h-6 w-6 text-[#1f5fbf]" aria-hidden />
            <span className="text-lg font-bold tracking-wide">LUXIA</span>
            <span className="text-lg text-slate-500">Identity</span>
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">J’ai perdu ma clé d’accès</h1>
          <p className="mt-1 text-base text-slate-600">
            Utilisez l’un de vos codes de récupération. Il ouvre une session limitée à 15 minutes, qui permet
            uniquement d’ajouter une nouvelle clé d’accès.
          </p>
        </div>
        <RecoverySignIn />
        <p className="mt-6 text-center text-sm text-slate-600">
          Vous n’avez pas de code de récupération ? Contactez l’administrateur de votre organisation.
        </p>
        <p className="mt-2 text-center text-sm"><Link href="/login" className="font-medium text-[#1f5fbf] hover:underline">Retour à la connexion</Link></p>
      </div>
    </div>
  );
}
