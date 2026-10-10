import React from 'react';
import { ShieldCheck, AlertCircle } from 'lucide-react';
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
    <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-8">
          <div className="mb-6 flex items-center gap-2 text-slate-900">
            <ShieldCheck className="h-6 w-6 text-[#1f5fbf]" aria-hidden />
            <span className="text-lg font-bold tracking-wide">LUXIA</span>
            <span className="text-lg text-slate-500">Identity</span>
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">Connexion</h1>
          <p className="mt-1 text-base text-slate-600">Indiquez l’identifiant de votre organisation, puis votre méthode de connexion.</p>
        </div>

        {errorMsg && (
          <div className="mb-6 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
            <p className="break-words">{errorMsg}</p>
          </div>
        )}

        <OrganizationLogin initialOrganization={typeof sp?.org === 'string' ? sp.org : ''} />
      </div>
    </div>
  );
}
