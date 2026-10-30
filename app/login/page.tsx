import React from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { AuthAlert, AuthShell } from '@/components/auth/auth-shell';
import { OrganizationLogin } from './organization-login';

export const dynamic = 'force-dynamic';

// Fixed messages only: the page never echoes text from the URL.
const ERRORS: Record<string, string> = {
  signin: 'Connexion impossible. Vérifiez l’identifiant de votre organisation.',
  rate_limited: 'Trop de tentatives. Réessayez dans quelques minutes.',
  unavailable: 'Le service de connexion est temporairement indisponible. Réessayez dans quelques minutes.',
};

// Customer Self-Onboarding v1 (requirements 2, 14, 15): the page reads nothing from the database.
// It always offers the same methods; the server resolves the organization from its identifier
// when a method is used, and reveals nothing about it before authentication.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; org?: string }> }) {
  const sp = await searchParams;
  const errorMsg = sp?.error ? ERRORS[sp.error] ?? '' : '';

  return (
    <AuthShell
      title="Connexion"
      description="Indiquez l’identifiant de votre organisation, puis connectez-vous avec votre clé d’accès."
      footer={<p>Vous avez un code d’accès bêta ? <Link href="/signup" className="lx-link">Créer une organisation</Link></p>}
    >
      {errorMsg && <div className="mb-5"><AuthAlert><AlertCircle size={18} className="mt-0.5 flex-shrink-0" aria-hidden /><span>{errorMsg}</span></AuthAlert></div>}
      <OrganizationLogin initialOrganization={typeof sp?.org === 'string' ? sp.org : ''} />
    </AuthShell>
  );
}
