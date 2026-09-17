import React from 'react';
import { ShieldCheck, Lock, AlertCircle } from 'lucide-react';
import { rawPrisma } from '@/lib/db/raw-prisma';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  // For the mono-tenant prototype, fetch the first available Entra ID connection
  const provider = await rawPrisma.providerConnection.findFirst({
    where: { providerType: 'MICROSOFT_ENTRA' }
  });

  const errorMsg = searchParams?.error || "";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-900 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-blue-500/20 blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-500/20 blur-[150px]"></div>
      </div>

      <div className="max-w-md w-full bg-slate-800/60 backdrop-blur-xl border border-slate-700/50 rounded-3xl p-8 shadow-2xl z-10 transform transition-all hover:scale-[1.01] duration-500">
        <div className="flex flex-col items-center mb-10">
          <div className="w-20 h-20 bg-gradient-to-tr from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30 mb-6 transform rotate-3 hover:rotate-6 transition-transform duration-300">
            <ShieldCheck className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">LUXIA Secure Access</h1>
          <p className="text-slate-400 mt-2 text-center text-sm font-medium">Authentification PME via Microsoft Entra ID.</p>
        </div>

        {errorMsg && (
          <div className="mb-6 p-4 bg-red-500/20 border border-red-500/50 rounded-xl text-red-200 text-sm flex items-start gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="break-words font-medium">{errorMsg}</p>
          </div>
        )}

        <div className="space-y-6">
          <div className="space-y-4">
            {provider ? (
              <Link 
                href={`/auth/login?connection=${provider.id}`}
                className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3.5 px-6 rounded-xl transition-all duration-300 shadow-lg shadow-blue-600/20 hover:shadow-blue-500/40 group"
              >
                <Lock className="w-5 h-5 group-hover:scale-110 transition-transform" />
                Connexion avec Microsoft
              </Link>
            ) : (
              <div className="p-4 bg-yellow-500/20 border border-yellow-500/50 rounded-xl text-yellow-200 text-sm text-center">
                Aucune configuration Entra ID trouvée pour cette instance.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
