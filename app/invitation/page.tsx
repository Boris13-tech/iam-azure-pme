import { ShieldCheck } from "lucide-react";
import { AcceptInvitation } from "./accept-invitation";

export const dynamic = "force-dynamic";

export default function InvitationPage() {
  return (
    <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-8">
          <div className="mb-6 flex items-center gap-2 text-slate-900">
            <ShieldCheck className="h-6 w-6 text-[#1f5fbf]" aria-hidden />
            <span className="text-lg font-bold tracking-wide">LUXIA</span>
            <span className="text-lg text-slate-500">Identity</span>
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">Rejoindre votre organisation</h1>
          <p className="mt-1 text-base text-slate-600">Ce lien d’invitation ne fonctionne qu’une fois et expire au bout de 7 jours.</p>
        </div>
        <AcceptInvitation />
      </div>
    </div>
  );
}
