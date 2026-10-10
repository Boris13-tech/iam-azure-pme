import React from 'react';
import { ShieldCheck, Lock, AlertCircle } from 'lucide-react';
import { rawPrisma } from '@/lib/db/raw-prisma';
import Link from 'next/link';
import { safeOperationalRead } from '@/lib/operations/identity-operational-readiness';
import { LocalPasskeyLogin } from './local-passkey-login';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  // For the mono-tenant prototype, fetch the first available Entra ID connection
  const discovery = await safeOperationalRead(() => rawPrisma.providerConnection.findFirst({
    where: { providerType: 'MICROSOFT_ENTRA' },
    include: {
      organization: {
        include: {
          tenants: {
            take: 1
          }
        }
      }
    }
  }), () => console.error('LOGIN_PROVIDER_DISCOVERY_UNAVAILABLE'));
  const provider = discovery.state === 'AVAILABLE' ? discovery.value : null;

  const localDiscovery = await safeOperationalRead(() => rawPrisma.providerConnection.findFirst({
    where: { providerType: 'LUXIA_LOCAL' },
    include: { organization: { include: { tenants: { take: 1 } } } }
  }), () => console.error('LOCAL_PROVIDER_DISCOVERY_UNAVAILABLE'));
  const localProvider = localDiscovery.state === 'AVAILABLE' ? localDiscovery.value : null;

  const defaultTenantId = provider?.organization?.tenants?.[0]?.id;

  const errorMsg = sp?.error || "";

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
          <p className="mt-1 text-base text-slate-600">Choisissez votre méthode de connexion.</p>
        </div>

        {errorMsg && (
          <div className="mb-6 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
            <p className="break-words">{errorMsg}</p>
          </div>
        )}

        <div className="space-y-6">
          <div className="space-y-4">
            {discovery.state === 'UNAVAILABLE' ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-4 text-center text-sm text-red-800">
                Le service de connexion est temporairement indisponible. Réessayez dans quelques minutes.
              </div>
            ) : provider && defaultTenantId ? (
              <Link 
                href={`/auth/login?tenant=${defaultTenantId}&connection=${provider.id}`}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-[#1f5fbf] px-4 py-2.5 text-base font-medium text-white hover:bg-[#194e9e]"
              >
                <Lock className="h-5 w-5" aria-hidden />
                Se connecter avec Microsoft
              </Link>
            ) : (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-center text-sm text-amber-900">
                La connexion Microsoft n’est pas configurée.
              </div>
            )}
            {localProvider?.organization?.tenants?.[0]?.id && (
              <LocalPasskeyLogin providerConnectionId={localProvider.id} tenantId={localProvider.organization.tenants[0].id} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
