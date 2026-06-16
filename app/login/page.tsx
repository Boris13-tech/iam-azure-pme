"use client";

import React, { useState } from 'react';
import { ShieldCheck, Lock, User, ArrowRight, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleMockLogin = () => {
    setIsLoading(true);
    // Simulate network delay and set a mock token cookie for local development bypassing
    setTimeout(() => {
      document.cookie = "access_token=mock_dev_token; path=/; max-age=3600";
      router.push('/audit');
    }, 1500);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-900 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Decorative background elements */}
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
          <p className="text-slate-400 mt-2 text-center text-sm font-medium">Authentification centralisée pour PME via Azure AD B2C.</p>
        </div>

        <div className="space-y-6">
          <div className="space-y-4">
            <button 
              onClick={handleMockLogin}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3.5 px-6 rounded-xl transition-all duration-300 shadow-lg shadow-blue-600/20 hover:shadow-blue-500/40 disabled:opacity-70 disabled:cursor-not-allowed group"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Lock className="w-5 h-5 group-hover:scale-110 transition-transform" />
              )}
              {isLoading ? "Connexion en cours..." : "Connexion SSO (Mode Démo)"}
            </button>
            
            <div className="relative flex items-center py-2">
              <div className="flex-grow border-t border-slate-700"></div>
              <span className="flex-shrink-0 mx-4 text-slate-500 text-xs uppercase tracking-wider font-semibold">ou administrateur local</span>
              <div className="flex-grow border-t border-slate-700"></div>
            </div>

            <button 
              onClick={handleMockLogin}
              disabled={isLoading}
              className="w-full flex items-center justify-between bg-slate-700/50 hover:bg-slate-700 text-slate-200 font-semibold py-3.5 px-6 rounded-xl transition-all duration-300 border border-slate-600 hover:border-slate-500 group"
            >
              <div className="flex items-center gap-3">
                <User className="w-5 h-5 text-slate-400 group-hover:text-white transition-colors" />
                <span>Accès Secours</span>
              </div>
              <ArrowRight className="w-5 h-5 text-slate-500 group-hover:text-white group-hover:translate-x-1 transition-all" />
            </button>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-700/50 text-center">
            <p className="text-xs text-slate-500">
              En vous connectant, vous acceptez les politiques de sécurité de votre entreprise. 
              Plateforme protégée par chiffrement de bout en bout.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}