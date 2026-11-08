import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";

// Private beta (O1): an organization is created only with a single-use code issued by LUXIA.
export default function SignupPage() {
  return (
    <AuthShell
      title="Créer une organisation"
      description="La création d’une organisation nécessite un code d’accès bêta fourni par LUXIA."
      footer={<p>Déjà inscrit ? <Link href="/login" className="lx-link">Se connecter</Link></p>}
    >
      <SignupForm />
    </AuthShell>
  );
}
