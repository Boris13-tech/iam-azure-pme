import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell, Bot, Building2, CircleHelp, Fingerprint, Gauge, KeyRound, Search, ShieldCheck, Users, Boxes } from "lucide-react";
import { getAuthContext } from "@/lib/auth/auth-context";
import { loadPlatformContext } from "@/lib/platform/context";

const navigation = [
  { href: "/dashboard", label: "Vue d’ensemble", icon: Gauge, entitlement: null },
  { href: "/dashboard/users", label: "Identités", icon: Users, entitlement: "subjects.read" },
  { href: "/dashboard/settings", label: "Authentification", icon: ShieldCheck, entitlement: "providers.read" },
  { href: "/dashboard/roles", label: "Accès", icon: KeyRound, entitlement: "assignments.read" },
  { href: "/dashboard/resources", label: "Resources", icon: Boxes, entitlement: "resources.read" },
  { href: "/dashboard/audit", label: "Sécurité", icon: Fingerprint, entitlement: "audit.read" },
];

function LuxiaMark() {
  return <div className="luxia-brand-mark" aria-hidden="true"><span className="luxia-mark-left" /><span className="luxia-mark-right" /></div>;
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  const platform = await loadPlatformContext(auth);
  const allowedNavigation = navigation.filter(item => !item.entitlement || platform.entitlements.includes(item.entitlement));
  return (
    <div className="luxia-shell">
      <aside className="luxia-sidebar">
        <Link href="/dashboard" className="luxia-logo"><LuxiaMark /><span><strong>LUXIA</strong><small>Identity</small></span></Link>
        <nav className="luxia-nav" aria-label="Navigation principale">
          {allowedNavigation.map(({ href, label, icon: Icon }) => (
            <Link key={label} href={href} className="luxia-nav-link">
              <Icon size={19} strokeWidth={1.9} /><span>{label}</span>{label === "Identités" && <span className="luxia-nav-arrow">›</span>}
            </Link>
          ))}
        </nav>
        <div className="luxia-sidebar-footer">
          <div className="luxia-sidebar-caption"><Bot size={18} /><span><b>LUXIA Identity</b>Des identités de confiance pour un monde sans frontières</span></div>
          <div className="luxia-version-row"><small>v2.4.0</small><form method="POST" action="/auth/logout"><button type="submit">Déconnexion</button></form></div>
        </div>
      </aside>
      <section className="luxia-workspace">
        <header className="luxia-topbar">
          <div className="luxia-contexts">
            <button aria-label="Organisation active"><Building2 size={16} /><span>Entreprise</span><b>{platform.organization.name}</b></button>
            <button aria-label="Tenant actif"><span className="luxia-live-dot" /><span>Tenant</span><b>{platform.tenant.name}</b></button>
          </div>
          <div className="luxia-top-actions">
            <label className="luxia-search"><Search size={17} /><input aria-label="Recherche" placeholder="Rechercher (utilisateurs, applications, ressources...)" /><kbd>⌘ K</kbd></label>
            <button className="luxia-icon-button" aria-label="Notifications"><Bell size={19} /><span>3</span></button>
            <button className="luxia-icon-button" aria-label="Aide"><CircleHelp size={19} /></button>
            <b className="luxia-language">FR</b>
            <div className="luxia-profile"><span>{platform.subject.name.split(" ").map(part => part[0]).join("").slice(0,2).toUpperCase()}</span><div><b>{platform.subject.name}</b><small>{platform.identity.providerType.replaceAll("_", " ")}</small></div></div>
          </div>
        </header>
        <main className="luxia-main">{children}</main>
      </section>
    </div>
  );
}
