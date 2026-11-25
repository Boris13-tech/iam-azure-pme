import Link from "next/link";
import { AuthShell } from "../components/auth/auth-shell";

// Custom 404 page using LUXIA's external stylesheet (avoids Next.js's built-in inline <style> fallback under strict CSP).
export default function NotFoundPage() {
  return (
    <AuthShell
      title="Page introuvable"
      description="L’adresse demandée n’existe pas ou n’est plus disponible."
    >
      <div className="lx-stack">
        <Link href="/login" className="lx-btn lx-btn--primary">
          Retour à l’accueil
        </Link>
      </div>
    </AuthShell>
  );
}
