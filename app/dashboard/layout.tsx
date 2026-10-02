import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell, Bot, Building2, ChevronDown, CircleHelp, Cuboid, Fingerprint, Gauge, KeyRound, Network, Search, ShieldCheck, Sparkles, Users } from "lucide-react";
import { getAuthContext } from "@/lib/auth/auth-context";

const navigation = [
  { href: "/dashboard", label: "Vue d’ensemble", icon: Gauge, active: true },
  { href: "/dashboard/users", label: "Identités", icon: Users },
  { href: "/dashboard/settings", label: "Authentification", icon: ShieldCheck },
  { href: "/dashboard/roles", label: "Accès", icon: KeyRound },
  { href: "/dashboard", label: "Ressources", icon: Cuboid },
  { href: "/dashboard", label: "Providers", icon: Network },
  { href: "/dashboard/audit", label: "Sécurité", icon: Fingerprint },
  { href: "/dashboard/settings", label: "Organisation", icon: Building2 },
];

function LuxiaMark() {
  return <div className="luxia-brand-mark" aria-hidden="true"><span className="luxia-mark-left" /><span className="luxia-mark-right" /></div>;
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  return (
    <div className="luxia-shell">
      <aside className="luxia-sidebar">
        <Link href="/dashboard" className="luxia-logo"><LuxiaMark /><span><strong>LUXIA</strong><small>Identity</small></span></Link>
        <nav className="luxia-nav" aria-label="Navigation principale">
          {navigation.map(({ href, label, icon: Icon, active }) => (
            <Link key={label} href={href} className={`luxia-nav-link ${active ? "is-active" : ""}`}>
              <Icon size={19} strokeWidth={1.9} /><span>{label}</span>{label === "Identités" && <span className="luxia-nav-arrow">›</span>}
            </Link>
          ))}
          <div className="luxia-nav-divider" />
          <Link href="/dashboard" className="luxia-nav-link luxia-alma-link"><Sparkles size={19} /><span>AI MA</span><em>Bêta</em></Link>
        </nav>
        <div className="luxia-sidebar-footer">
          <div className="luxia-sidebar-caption"><Bot size={18} /><span><b>LUXIA Identity</b>Des identités de confiance pour un monde sans frontières</span></div>
          <div className="luxia-version-row"><small>v2.4.0</small><form method="POST" action="/auth/logout"><button type="submit">Déconnexion</button></form></div>
        </div>
      </aside>
      <section className="luxia-workspace">
        <header className="luxia-topbar">
          <div className="luxia-contexts">
            <button><Building2 size={16} /><span>Entreprise</span><b>Legrand Tech</b><ChevronDown size={15} /></button>
            <button><span className="luxia-live-dot" /><span>Environnement</span><b>Production</b><ChevronDown size={15} /></button>
          </div>
          <div className="luxia-top-actions">
            <label className="luxia-search"><Search size={17} /><input aria-label="Recherche" placeholder="Rechercher (utilisateurs, applications, ressources...)" /><kbd>⌘ K</kbd></label>
            <button className="luxia-icon-button" aria-label="Notifications"><Bell size={19} /><span>3</span></button>
            <button className="luxia-icon-button" aria-label="Aide"><CircleHelp size={19} /></button>
            <b className="luxia-language">FR</b>
            <div className="luxia-profile"><span>LB</span><div><b>Legrand Boris</b><small>Administrateur global</small></div><ChevronDown size={15} /></div>
          </div>
        </header>
        <main className="luxia-main">{children}</main>
      </section>
    </div>
  );
}
