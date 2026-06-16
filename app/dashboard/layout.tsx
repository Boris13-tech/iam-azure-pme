import React from "react";
import Link from "next/link";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 flex font-sans">
      <aside className="w-64 bg-[#0f172a] text-slate-300 flex-col hidden md:flex shadow-xl z-10">
        <div className="h-16 flex items-center px-6 font-bold text-2xl border-b border-white/10 tracking-tight text-white">
          LUXIA
        </div>
        <nav className="flex-1 px-4 py-6 space-y-2.5">
          <Link href="/" className="block px-4 py-3 rounded-xl hover:bg-white/10 hover:text-white transition-all font-semibold text-sm">Dashboard</Link>
          <Link href="/users" className="block px-4 py-3 rounded-xl hover:bg-white/10 hover:text-white transition-all font-semibold text-sm">Utilisateurs</Link>
          <Link href="/roles" className="block px-4 py-3 rounded-xl hover:bg-white/10 hover:text-white transition-all font-semibold text-sm">Rôles & Permissions</Link>
          <Link href="/audit" className="block px-4 py-3 rounded-xl hover:bg-white/10 hover:text-white transition-all font-semibold text-sm">Journal d'Audit</Link>
          <Link href="/settings" className="block px-4 py-3 rounded-xl hover:bg-white/10 hover:text-white transition-all font-semibold text-sm">Politiques d'Accès</Link>
        </nav>
        <div className="p-5 border-t border-white/10">
          <button className="w-full bg-indigo-600/90 hover:bg-indigo-500 py-2.5 rounded-xl transition-colors font-bold text-white shadow-lg text-sm">
            Déconnexion
          </button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-16 bg-white/80 backdrop-blur-md border-b border-slate-200 flex items-center justify-between px-8 z-0">
          <h1 className="text-lg font-bold text-slate-800 tracking-tight">Espace Administration PME</h1>
          <div className="flex items-center space-x-4">
            <span className="text-xs font-bold text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100">
              Session Active
            </span>
            <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 shadow-inner"></div>
          </div>
        </header>
        <div className="flex-1 p-8 overflow-y-auto w-full max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}