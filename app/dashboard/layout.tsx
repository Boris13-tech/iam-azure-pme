import React from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { loadPlatformContext } from "@/lib/platform/context";
import { AppShell, type NavItem } from "@/components/app-shell/app-shell";

const navigation: Array<NavItem & { entitlement: string | null }> = [
  { href: "/dashboard", label: "Vue d’ensemble", icon: "overview", group: "Pilotage", entitlement: null },
  { href: "/dashboard/users", label: "Identités", icon: "users", group: "Identités et accès", entitlement: "subjects.read" },
  { href: "/dashboard/organization", label: "Organisation", icon: "organization", group: "Identités et accès", entitlement: "subjects.read" },
  { href: "/dashboard/settings", label: "Authentification", icon: "authentication", group: "Identités et accès", entitlement: "providers.read" },
  { href: "/dashboard/resources", label: "Ressources", icon: "resources", group: "Gouvernance", entitlement: "resources.read" },
  { href: "/dashboard/governance/sod", label: "Séparation des tâches", icon: "sod", group: "Gouvernance", entitlement: "sod.read" },
  { href: "/dashboard/governance/access-reviews", label: "Revues d’accès", icon: "reviews", group: "Gouvernance", entitlement: "access_reviews.read" },
  { href: "/dashboard/audit", label: "Journal d’audit", icon: "audit", group: "Sécurité", entitlement: "audit.read" },
];

const PROVIDER_LABELS: Record<string, string> = { MICROSOFT_ENTRA: "Microsoft Entra ID", LUXIA_LOCAL: "Compte local LUXIA" };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  const platform = await loadPlatformContext(auth);
  const allowedNavigation = navigation.filter(item => !item.entitlement || platform.entitlements.includes(item.entitlement));
  const initials = platform.subject.name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();
  return (
    <AppShell items={allowedNavigation.map(({ entitlement: _entitlement, ...item }) => item)}
      organization={platform.organization.name} environment={platform.tenant.name}
      person={{ name: platform.subject.name, initials, method: PROVIDER_LABELS[platform.identity.providerType] ?? platform.identity.providerType }}>
      {children}
    </AppShell>
  );
}
