import React from "react";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
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
    <AuthShell
      title="Récupération de votre compte"
      description={<>Votre session de récupération expire dans {minutes} minute{minutes > 1 ? "s" : ""}. Ajoutez une nouvelle clé d’accès
        sur cet appareil : vos anciennes clés d’accès et vos autres sessions seront révoquées, puis vous vous connecterez avec la nouvelle clé.</>}
    >
      <div className="lx-stack">
        <RecoveryEnrollment />
        <form method="POST" action="/auth/logout">
          <button type="submit" className="lx-btn lx-btn--secondary">Se déconnecter</button>
        </form>
      </div>
    </AuthShell>
  );
}
