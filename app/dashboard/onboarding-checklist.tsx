"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";
import { RECOVERY_SECTION_ID } from "./settings/recovery-codes";

// Customer Self-Onboarding v1, step 7: facts from canonical data, no score. Rendered only for people who
// may read it (B5: the overview does not even ask otherwise), hidden when it cannot be loaded or once
// every item that applies is done. An item that does not apply (null) is not shown.
const ITEMS = [
  { key: "domainVerified", label: "Vérifier un domaine de l’organisation", href: "/dashboard/organization" },
  { key: "secondAdministrator", label: "Avoir un second administrateur permanent, qui peut se connecter", href: "/dashboard/organization" },
  { key: "recoveryCodes", label: "Chaque administrateur qui se connecte par clé d’accès a créé ses codes de récupération", href: `/dashboard/settings#${RECOVERY_SECTION_ID}` },
  { key: "teamInvited", label: "Inviter votre équipe", href: "/dashboard/organization" },
  { key: "firstResource", label: "Enregistrer une première ressource", href: "/dashboard/resources" },
  { key: "firstAccessReview", label: "Lancer une première revue d’accès", href: "/dashboard/governance/access-reviews" },
] as const;
type Items = Record<(typeof ITEMS)[number]["key"], boolean | null>;

export function OnboardingChecklist() {
  const [items, setItems] = useState<Items | null>(null);
  useEffect(() => {
    fetch("/api/onboarding/checklist", { cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then(body => setItems(body?.items ?? null))
      .catch(() => setItems(null));
  }, []);
  const applicable = items ? ITEMS.filter(item => items[item.key] !== null && items[item.key] !== undefined) : [];
  if (!items || applicable.every(item => items[item.key])) return null;
  const done = applicable.filter(item => items[item.key]).length;
  return <section className="luxia-panel posture-section" aria-label="Mise en route">
    <header><h2><ListChecks size={18} aria-hidden /> Mise en route</h2></header>
    {/* One segment per step, done or not: facts only. */}
    <div className="luxia-progress">
      <span className="luxia-steps" role="img" aria-label={`${done} étape${done > 1 ? "s" : ""} terminée${done > 1 ? "s" : ""} sur ${applicable.length}`}>
        {applicable.map(item => <span key={item.key} className={items[item.key] ? "is-done" : undefined} />)}
      </span>
      <span>{done} sur {applicable.length} terminée{done > 1 ? "s" : ""}</span>
    </div>
    <ul className="luxia-checklist">
      {applicable.map(item => <li key={item.key} className={items[item.key] ? "is-done" : undefined}>
        <span>
          {items[item.key] ? <CheckCircle2 size={18} aria-label="Fait" /> : <Circle size={18} aria-label="À faire" />}
          {item.label}
        </span>
        {!items[item.key] && <Link href={item.href}>Ouvrir</Link>}
      </li>)}
    </ul>
  </section>;
}
