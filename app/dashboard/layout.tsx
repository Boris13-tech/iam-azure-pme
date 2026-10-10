import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Boxes, Building2, ClipboardCheck, Fingerprint, Gauge, Scale, ShieldCheck, Users } from "lucide-react";
import { getAuthContext } from "@/lib/auth/auth-context";
import { loadPlatformContext } from "@/lib/platform/context";

const navigation = [
  { href: "/dashboard", label: "Vue d’ensemble", icon: Gauge, entitlement: null },
  { href: "/dashboard/users", label: "Identités", icon: Users, entitlement: "subjects.read" },
  { href: "/dashboard/settings", label: "Authentification", icon: ShieldCheck, entitlement: "providers.read" },
  { href: "/dashboard/resources", label: "Ressources", icon: Boxes, entitlement: "resources.read" },
  { href: "/dashboard/governance/sod", label: "Séparation des tâches", icon: Scale, entitlement: "sod.read" },
  { href: "/dashboard/governance/access-reviews", label: "Revues d’accès", icon: ClipboardCheck, entitlement: "access_reviews.read" },
  { href: "/dashboard/audit", label: "Journal d’audit", icon: Fingerprint, entitlement: "audit.read" },
];

const PROVIDER_LABELS: Record<string, string> = { MICROSOFT_ENTRA: "Microsoft Entra ID", LUXIA_LOCAL: "Compte local LUXIA" };

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
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="luxia-sidebar-footer">
          <form method="POST" action="/auth/logout"><button type="submit">Se déconnecter</button></form>
        </div>
      </aside>
      <section className="luxia-workspace">
        <header className="luxia-topbar">
          <div className="luxia-contexts">
            <div><Building2 size={16} aria-hidden /><span>Organisation</span><b>{platform.organization.name}</b></div>
            <div><span className="luxia-live-dot" aria-hidden /><span>Environnement</span><b>{platform.tenant.name}</b></div>
          </div>
          <div className="luxia-top-actions">
            <div className="luxia-profile"><span>{platform.subject.name.split(" ").map(part => part[0]).join("").slice(0,2).toUpperCase()}</span><div><b>{platform.subject.name}</b><small>{PROVIDER_LABELS[platform.identity.providerType] ?? platform.identity.providerType}</small></div></div>
          </div>
        </header>
        <main className="luxia-main">{children}</main>
      </section>
    </div>
  );
}
