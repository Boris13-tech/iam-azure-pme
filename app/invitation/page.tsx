import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptInvitation } from "./accept-invitation";

export const dynamic = "force-dynamic";

export default function InvitationPage() {
  return (
    <AuthShell title="Rejoindre votre organisation" description="Ce lien d’invitation ne fonctionne qu’une fois et expire au bout de 7 jours.">
      <AcceptInvitation />
    </AuthShell>
  );
}
