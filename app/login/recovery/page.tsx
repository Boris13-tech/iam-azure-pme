import React from "react";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { RecoverySignIn } from "./recovery-sign-in";

export const dynamic = "force-dynamic";

// First Admin / Break-glass v1, B2: sign-in with a personal recovery code. The page reads nothing from
// the database and every refusal shows the same message.
export default function RecoveryLoginPage() {
  return (
    <AuthShell
      title="J’ai perdu ma clé d’accès"
      description="Utilisez l’un de vos codes de récupération. Il ouvre une session limitée à 15 minutes, qui permet uniquement d’ajouter une nouvelle clé d’accès."
      footer={<>
        <p>Vous n’avez pas de code de récupération ? Contactez l’administrateur de votre organisation.</p>
        <p><Link href="/login" className="lx-link">Retour à la connexion</Link></p>
      </>}
    >
      <RecoverySignIn />
    </AuthShell>
  );
}
