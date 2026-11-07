import type { NavItem } from "@/components/app-shell/app-shell";
import { REVIEW_READ_RIGHTS } from "@/lib/resources/access-review-visibility";

// An item shows when the viewer holds its right, or any one of its rights (the same rule as the page behind it).
export const DASHBOARD_NAVIGATION: ReadonlyArray<NavItem & { entitlement: string | readonly string[] | null }> = [
  { href: "/dashboard", label: "Vue d’ensemble", icon: "overview", group: "Pilotage", entitlement: null },
  { href: "/dashboard/users", label: "Identités", icon: "users", group: "Identités et accès", entitlement: "subjects.read" },
  { href: "/dashboard/organization", label: "Organisation", icon: "organization", group: "Identités et accès", entitlement: "subjects.read" },
  { href: "/dashboard/settings", label: "Authentification", icon: "authentication", group: "Identités et accès", entitlement: "providers.read" },
  { href: "/dashboard/resources", label: "Ressources", icon: "resources", group: "Gouvernance", entitlement: "resources.read" },
  { href: "/dashboard/governance/sod", label: "Séparation des tâches", icon: "sod", group: "Gouvernance", entitlement: "sod.read" },
  { href: "/dashboard/governance/access-reviews", label: "Revues d’accès", icon: "reviews", group: "Gouvernance", entitlement: REVIEW_READ_RIGHTS },
  { href: "/dashboard/audit", label: "Journal d’audit", icon: "audit", group: "Sécurité", entitlement: "audit.read" },
];

/** The items the viewer may see, on the server, without their rights (the client frame never receives them). */
export function visibleNavigation(entitlements: readonly string[]): NavItem[] {
  return DASHBOARD_NAVIGATION
    .filter(item => !item.entitlement ||
      (typeof item.entitlement === "string" ? [item.entitlement] : item.entitlement).some(key => entitlements.includes(key)))
    .map(({ entitlement: _entitlement, ...item }) => item);
}
