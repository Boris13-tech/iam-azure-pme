import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";

// Private beta (O1): an organization is created only with a single-use code issued by LUXIA.
export default function SignupPage() {
  return (
    <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-8">
          <div className="mb-6 flex items-center gap-2 text-slate-900">
            <ShieldCheck className="h-6 w-6 text-[#1f5fbf]" aria-hidden />
            <span className="text-lg font-bold tracking-wide">LUXIA</span>
            <span className="text-lg text-slate-500">Identity</span>
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">Créer une organisation</h1>
          <p className="mt-1 text-base text-slate-600">La création d’une organisation nécessite un code d’accès bêta fourni par LUXIA.</p>
        </div>
        <SignupForm />
        <p className="mt-6 text-center text-sm text-slate-600">Déjà inscrit ? <Link href="/login" className="font-medium text-[#1f5fbf] hover:underline">Se connecter</Link></p>
      </div>
    </div>
  );
}
