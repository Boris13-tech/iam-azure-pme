"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, Building2, ClipboardCheck, Fingerprint, Gauge, LogOut, Menu, Scale, ShieldCheck, Users, X } from "lucide-react";
import { LuxiaLogo } from "@/components/brand/luxia-logo";

// The signed-in frame: the brand's night sidebar (grouped navigation, the current page marked, the person at the
// bottom), a light work surface, and an off-canvas menu on narrow screens. Navigation entries arrive already
// filtered by the person's entitlements (app/dashboard/layout.tsx); this component only renders them.
const ICONS = { overview: Gauge, users: Users, organization: Building2, authentication: ShieldCheck, resources: Boxes,
  sod: Scale, reviews: ClipboardCheck, audit: Fingerprint } as const;
export type NavIcon = keyof typeof ICONS;
export type NavItem = { href: string; label: string; icon: NavIcon; group: string };

const isActive = (pathname: string, href: string) =>
  href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

export function AppShell({ items, organization, environment, person, children }: {
  items: NavItem[]; organization: string; environment: string;
  person: { name: string; initials: string; method: string }; children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [pathname]);
  const groups = items.reduce<Array<{ name: string; items: NavItem[] }>>((all, item) => {
    const group = all.find(g => g.name === item.group);
    if (group) group.items.push(item); else all.push({ name: item.group, items: [item] });
    return all;
  }, []);

  return (
    <div className="luxia-shell" data-nav-open={open ? "true" : "false"}>
      <aside className="luxia-sidebar" id="luxia-navigation">
        <div className="luxia-logo">
          <Link href="/dashboard" aria-label="LUXIA Identity, vue d’ensemble"><LuxiaLogo onDark product="LUXIA Identity" /></Link>
          <button type="button" className="luxia-nav-close" onClick={() => setOpen(false)} aria-label="Fermer le menu"><X size={20} aria-hidden /></button>
        </div>
        <nav className="luxia-nav" aria-label="Navigation principale">
          {groups.map(group => (
            <div key={group.name} className="luxia-nav-group">
              <p>{group.name}</p>
              {group.items.map(({ href, label, icon }) => {
                const Icon = ICONS[icon];
                const active = isActive(pathname, href);
                return (
                  <Link key={href} href={href} className={`luxia-nav-link${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined}>
                    <Icon size={18} strokeWidth={1.8} aria-hidden /><span>{label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="luxia-sidebar-footer">
          <div className="luxia-person">
            <span className="luxia-avatar" aria-hidden>{person.initials}</span>
            <span><b>{person.name}</b><small>{person.method}</small></span>
          </div>
          <form method="POST" action="/auth/logout">
            <button type="submit" className="luxia-signout"><LogOut size={16} aria-hidden /> Se déconnecter</button>
          </form>
        </div>
      </aside>
      <div className="luxia-scrim" onClick={() => setOpen(false)} aria-hidden />
      <section className="luxia-workspace">
        <header className="luxia-topbar">
          <button type="button" className="luxia-menu-button" onClick={() => setOpen(true)} aria-label="Ouvrir le menu"
            aria-controls="luxia-navigation" aria-expanded={open}><Menu size={20} aria-hidden /></button>
          <div className="luxia-contexts">
            <div><Building2 size={15} aria-hidden /><span>Organisation</span><b>{organization}</b></div>
            <div><span className="luxia-live-dot" aria-hidden /><span>Environnement</span><b>{environment}</b></div>
          </div>
        </header>
        <main className="luxia-main">{children}</main>
      </section>
    </div>
  );
}
