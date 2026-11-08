import React from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { loadPlatformContext } from "@/lib/platform/context";
import { AppShell } from "@/components/app-shell/app-shell";
import { visibleNavigation } from "@/lib/navigation/dashboard";

const PROVIDER_LABELS: Record<string, string> = { MICROSOFT_ENTRA: "Microsoft Entra ID", LUXIA_LOCAL: "Compte local LUXIA" };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  const platform = await loadPlatformContext(auth);
  const initials = platform.subject.name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();
  return (
    <AppShell items={visibleNavigation(platform.entitlements)}
      organization={platform.organization.name} environment={platform.tenant.name}
      person={{ name: platform.subject.name, initials, method: PROVIDER_LABELS[platform.identity.providerType] ?? platform.identity.providerType }}>
      {children}
    </AppShell>
  );
}
