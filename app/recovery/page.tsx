import React from "react";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getRecoveryContext } from "@/lib/auth/recovery-session";
import { RecoveryEnrollment } from "./recovery-enrollment";

export const dynamic = "force-dynamic";

// First Admin / Break-glass v1, B2: the only page a recovery session can render. Two actions, add a
// new passkey or sign out; no navigation and no data.
export default async function RecoveryPage() {
  const recovery = await getRecoveryContext();
  if (!recovery) redirect("/login");
  const minutes = Math.max(1, Math.ceil((recovery.recovery.expiresAt.getTime() - Date.now()) / 60_000));
  return (
    <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-6 flex items-center gap-2 text-slate-900">
          <ShieldCheck className="h-6 w-6 text-[#1f5fbf]" aria-hidden />
          <span className="text-lg font-bold tracking-wide">LUXIA</span>
          <span className="text-lg text-slate-500">Identity</span>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">Récupération de votre compte</h1>
        <p className="mt-2 text-base text-slate-700">
          Votre session de récupération expire dans {minutes} minute{minutes > 1 ? "s" : ""}.
        </p>
        <p className="mt-1 text-sm text-slate-600">
          Ajoutez une nouvelle clé d’accès sur cet appareil. Vos anciennes clés d’accès et vos autres sessions seront
          révoquées, puis vous vous connecterez avec la nouvelle clé.
        </p>
        <div className="mt-6 space-y-3">
          <RecoveryEnrollment />
          <form method="POST" action="/auth/logout">
            <button type="submit" className="w-full rounded-md border border-slate-300 bg-white px-4 py-2.5 text-base font-medium text-slate-800 hover:bg-slate-50">
              Se déconnecter
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
