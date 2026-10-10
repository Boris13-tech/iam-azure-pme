"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, Boxes, KeyRound, Scale, ShieldCheck, Users } from "lucide-react";
import { RESULT_LABELS, operationLabel } from "../../lib/ui/activity-labels";
import { breakdownTotal, type ActivityEntry, type Breakdown, type PostureResponse, type SectionId, type Widget, type WidgetId } from "../../lib/dashboard/posture-contract";

// Identity security posture: real canonical data only, no score, no estimate.
// A real 0 is shown as 0; unavailable, not implemented and restricted (hidden) are rendered distinctly.

const SECTIONS: Record<SectionId, { title: string; icon: typeof Users }> = {
  identity: { title: "Identités", icon: Users },
  sessions: { title: "Sessions et authentification", icon: KeyRound },
  access: { title: "Accès", icon: ShieldCheck },
  resources: { title: "Ressources", icon: Boxes },
  governance: { title: "Gouvernance", icon: Scale },
  activity: { title: "Activité récente", icon: Activity },
};

const LABELS: Record<WidgetId, string> = {
  "identity.subjectsByLifecycle": "Identités par statut",
  "identity.subjectsByType": "Identités par type",
  "identity.accountsByProvider": "Comptes par fournisseur",
  "identity.recoveryRequiredSubjects": "Identités en récupération",
  "identity.activeSubjectsWithoutActiveAccount": "Identités actives sans compte actif",
  "identity.unresolvedProviderCollisions": "Conflits d’identité non résolus",
  "sessions.active": "Sessions actives",
  "sessions.activeSubjects": "Identités connectées",
  "sessions.activeByProvider": "Sessions actives par fournisseur",
  "sessions.started24h": "Sessions ouvertes (24 h)",
  "sessions.started7d": "Sessions ouvertes (7 jours)",
  "sessions.revoked7d": "Sessions révoquées (7 jours)",
  "auth.localAuthenticatorsByStatus": "Moyens d’authentification locaux",
  "auth.compromisedLocalAuthenticators": "Moyens d’authentification compromis",
  "auth.lockedLocalIdentities": "Comptes locaux verrouillés",
  "auth.pendingCredentialReenrollments": "Réinscriptions en attente",
  "auth.localSignInEvidence7d": "Connexions locales (7 jours)",
  "auth.entraSignInEvidence": "Connexions Microsoft Entra ID (7 jours)",
  "auth.signIns24hByMethod": "Connexions réussies (24 h)",
  "auth.rejectedSignIns24h": "Connexions refusées (24 h)",
  "auth.entraMfaConditionalAccess": "MFA et accès conditionnel Entra",
  "access.effectiveAssignments": "Accès en vigueur",
  "access.effectiveHolders": "Identités disposant d’un accès",
  "access.effectiveBySource": "Accès par origine",
  "access.timeBoundVsPermanent": "Durée des accès",
  "access.administrativeEntitlementHolders": "Personnes par droit d’administration",
  "access.nonActiveSubjectsWithEffectiveAccess": "Identités inactives ayant encore un accès",
  "access.expiringWithin7d": "Accès expirant sous 7 jours",
  "access.activeRowsPastValidity": "Accès expirés encore marqués actifs",
  "access.effectiveLegacyRoleAssignments": "Accès issus d’anciens rôles",
  "resources.activeByType": "Ressources par type",
  "resources.activeScopesByKind": "Périmètres par type",
  "resources.activeScopedEntitlements": "Droits définis sur les ressources",
  "resources.withoutEffectiveHolder": "Ressources sans aucun accès attribué",
  "resources.providerBoundVsNative": "Origine des ressources",
  "governance.sodPoliciesByStatus": "Politiques de séparation des tâches",
  "governance.sodEnabledRules": "Règles de séparation actives",
  "governance.sodDeniedAttempts30d": "Attributions bloquées (30 jours)",
  "governance.sodExistingViolations": "Conflits parmi les accès existants",
  "governance.reviewCampaignsByStatus": "Campagnes de revue",
  "governance.overdueReviewCampaigns": "Campagnes de revue en retard",
  "governance.pendingReviewItems": "Accès en attente de revue",
  "governance.reviewItemsRequiringRemediation": "Accès à corriger après revue",
  "governance.myPendingReviewDecisions": "Mes décisions de revue en attente",
  "activity.recentChangesAndDenials": "Derniers événements",
  "activity.deniedOrFailed24h": "Refus et échecs (24 h)",
  "activity.deniedOrFailed7d": "Refus et échecs (7 jours)",
  "activity.privilegedChanges7d": "Modifications sensibles (7 jours)",
};

const DRILL: Partial<Record<WidgetId, string>> = {
  "identity.subjectsByLifecycle": "/dashboard/users", "identity.subjectsByType": "/dashboard/users",
  "identity.accountsByProvider": "/dashboard/users", "identity.recoveryRequiredSubjects": "/dashboard/users",
  "identity.activeSubjectsWithoutActiveAccount": "/dashboard/users", "access.nonActiveSubjectsWithEffectiveAccess": "/dashboard/users",
  "access.effectiveAssignments": "/dashboard/resources", "sessions.revoked7d": "/dashboard/audit",
  "resources.activeByType": "/dashboard/resources", "resources.activeScopesByKind": "/dashboard/resources",
  "resources.activeScopedEntitlements": "/dashboard/resources", "resources.withoutEffectiveHolder": "/dashboard/resources/onboarding",
  "governance.sodPoliciesByStatus": "/dashboard/governance/sod", "governance.sodEnabledRules": "/dashboard/governance/sod",
  "governance.sodDeniedAttempts30d": "/dashboard/governance/sod", "governance.reviewCampaignsByStatus": "/dashboard/governance/access-reviews",
  "governance.overdueReviewCampaigns": "/dashboard/governance/access-reviews", "governance.pendingReviewItems": "/dashboard/governance/access-reviews",
  "governance.reviewItemsRequiringRemediation": "/dashboard/governance/access-reviews", "governance.myPendingReviewDecisions": "/dashboard/governance/access-reviews",
  "activity.recentChangesAndDenials": "/dashboard/audit", "activity.deniedOrFailed24h": "/dashboard/audit",
  "activity.deniedOrFailed7d": "/dashboard/audit", "activity.privilegedChanges7d": "/dashboard/audit",
};

const REASONS: Record<string, string> = {
  QUERY_FAILED: "Cette donnée n’a pas pu être chargée.",
  ENTRA_EVIDENCE_NOT_RECORDED: "Aucune connexion Microsoft Entra ID enregistrée pour l’instant.",
  REQUIRES_PROVIDER_GRAPH_INTEGRATION: "Nécessite l’intégration Microsoft Graph.",
  SOD_ENGINE_IS_PREVENTIVE_ONLY: "Pour l’instant, seules les nouvelles attributions sont contrôlées.",
};

// Readable labels for canonical codes. Unknown codes are shown unchanged rather than guessed.
const TERMS: Record<string, string> = {
  PROVISIONING: "En création", ACTIVE: "Actives", SUSPENDED: "Suspendues", DISABLED: "Désactivées", RECOVERY_REQUIRED: "En récupération", RETIRED: "Retirées",
  HUMAN: "Personnes", WORKLOAD: "Charges de travail", SERVICE: "Services", DEVICE: "Appareils", AI_AGENT: "Agents IA",
  MICROSOFT_ENTRA: "Microsoft Entra ID", LUXIA_LOCAL: "Compte local LUXIA", LDAP: "LDAP", ACTIVE_DIRECTORY: "Active Directory", SAMBA_AD: "Samba AD",
  AWS: "AWS", GOOGLE_WORKSPACE: "Google Workspace", GITHUB: "GitHub", CUSTOM: "Autre",
  VERIFIED: "Réussies", REJECTED: "Refusées", VERIFIED_PHISHING_RESISTANT: "dont résistantes à l’hameçonnage",
  FEDERATED_OIDC: "Microsoft Entra ID", PASSKEY: "Clé d’accès", SECURITY_KEY: "Clé de sécurité", TOTP: "Code à usage unique",
  LEGACY_ROLE: "Ancien rôle", DIRECT: "Attribution directe", PROVIDER: "Fournisseur", POLICY: "Politique", SYSTEM: "Système",
  TIME_BOUND: "Limités dans le temps", PERMANENT: "Permanents",
  APPLICATION: "Applications", API: "API", DATASET: "Jeux de données", DATABASE: "Bases de données", REPOSITORY: "Dépôts de code",
  CLOUD_RESOURCE: "Ressources cloud", SAAS: "Applications SaaS", STORAGE: "Stockage", SECRET: "Secrets", AI_TOOL: "Outils IA", OTHER: "Autres",
  RESOURCE: "Ressource unique", RESOURCE_GROUP: "Groupe de ressources", TENANT: "Environnement entier",
  PROVIDER_BOUND: "Liées à un fournisseur", NATIVE: "Créées dans LUXIA", OPEN: "En cours", COMPLETED: "Terminées",
};
const ACCOUNT_STATUS: Record<string, string> = { ACTIVE: "actifs", DISABLED: "désactivés" };
const AUTHENTICATOR: Record<string, string> = { PASSKEY: "Clés d’accès", TOTP: "Codes à usage unique", SECURITY_KEY: "Clés de sécurité",
  SMART_CARD: "Cartes à puce", MANAGED_DEVICE: "Appareils gérés", CUSTOM: "Autres" };
const AUTHENTICATOR_STATUS: Record<string, string> = { PENDING: "en attente", ACTIVE: "actives", SUSPENDED: "suspendues", REVOKED: "révoquées",
  COMPROMISED: "compromises", EXPIRED: "expirées", SUPERSEDED: "remplacées" };
const RIGHTS: Record<string, string> = {
  "users.create": "Créer des utilisateurs (ancien)", "users.update": "Modifier des utilisateurs (ancien)", "users.delete": "Supprimer des utilisateurs (ancien)",
  "roles.create": "Créer des rôles (ancien)", "roles.update": "Modifier des rôles (ancien)", "roles.delete": "Supprimer des rôles (ancien)", "roles.manage": "Gérer les rôles (ancien)",
  "settings.update": "Modifier les paramètres", "subjects.create": "Créer des identités", "subjects.update": "Modifier des identités",
  "identity_accounts.link": "Lier des comptes", "identity_accounts.disable": "Désactiver des comptes", "assignments.manage": "Attribuer des accès",
  "sessions.revoke": "Révoquer des sessions", "providers.manage": "Gérer les fournisseurs", "resources.manage": "Gérer les ressources",
  "sod.manage": "Gérer la séparation des tâches", "access_reviews.create": "Créer des revues d’accès", "access_reviews.decide": "Décider des revues d’accès",
  "access_reviews.manage": "Gérer les revues d’accès",
};

function categoryLabel(id: WidgetId, key: string): string {
  if (id === "access.administrativeEntitlementHolders") return RIGHTS[key] ?? key;
  if (id === "identity.accountsByProvider") { const [p, s] = key.split("."); return `${TERMS[p] ?? p}, ${ACCOUNT_STATUS[s] ?? s}`; }
  if (id === "auth.localAuthenticatorsByStatus") { const [t, s] = key.split("."); return `${AUTHENTICATOR[t] ?? t}, ${AUTHENTICATOR_STATUS[s] ?? s}`; }
  return TERMS[key] ?? key;
}

const fr = (n: number) => n.toLocaleString("fr-FR");

function BreakdownView({ id, value, since }: { id: WidgetId; value: Breakdown; since?: string }) {
  const nonZero = Object.entries(value).filter(([, n]) => n > 0);
  // Overlapping categories (a subset, or one holder per right) are never summed into a total.
  const total = breakdownTotal(id, value);
  return <div className="posture-breakdown">
    {total !== null ? <strong>{fr(total)}</strong> : nonZero.length === 0 && <strong>0</strong>}
    {nonZero.length > 0 && <ul>{nonZero.map(([k, n]) => <li key={k}><span>{categoryLabel(id, k)}</span><b>{fr(n)}</b></li>)}</ul>}
    {since && <small>Enregistrées depuis le {new Date(since).toLocaleDateString("fr-FR")}</small>}
  </div>;
}

function ActivityView({ value }: { value: readonly ActivityEntry[] }) {
  if (value.length === 0) return <p className="posture-muted">Aucun événement.</p>;
  return <ul className="posture-activity">{value.map(e => {
    const who = e.actorName ? (e.targetName && e.targetName !== e.actorName ? `Par ${e.actorName}, pour ${e.targetName}` : `Par ${e.actorName}`) : null;
    return <li key={e.id}>
      <span className={e.result === "SUCCESS" ? "ok" : "danger"} aria-hidden />
      <div><b title={e.operation}>{operationLabel(e.operation) ?? "Autre action"}</b><small>{RESULT_LABELS[e.result] ?? e.result}{who ? `. ${who}.` : "."}</small></div>
      <time dateTime={e.occurredAt}>{new Date(e.occurredAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</time>
    </li>;
  })}</ul>;
}

function WidgetCard({ widget, attention }: { widget: Exclude<Widget, { state: "restricted" }>; attention: boolean }) {
  const href = DRILL[widget.id];
  const body = widget.state === "ok"
    ? typeof widget.value === "number" ? <strong className="posture-number">{fr(widget.value)}</strong>
      : Array.isArray(widget.value) ? <ActivityView value={widget.value as readonly ActivityEntry[]} />
      : <BreakdownView id={widget.id} value={widget.value as Breakdown} since={widget.since} />
    : widget.state === "unavailable" ? <p className="posture-state unavailable"><b>Indisponible</b><small>{REASONS[widget.reason] ?? widget.reason}</small></p>
    : <p className="posture-state not-implemented"><b>Pas encore disponible</b><small>{REASONS[widget.reason] ?? widget.reason}</small></p>;
  const flagged = attention && widget.state === "ok" && typeof widget.value === "number" && widget.value > 0;
  return <article className={`posture-widget${flagged ? " is-attention" : ""}${widget.id === "activity.recentChangesAndDenials" ? " is-wide" : ""}`}>
    <header><h3>{LABELS[widget.id]}</h3>{href && <Link href={href}>Voir</Link>}</header>{body}
  </article>;
}

export default function DashboardPage() {
  const [data, setData] = useState<PostureResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/canonical/posture", { signal: abort.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("POSTURE_UNAVAILABLE"); return response.json(); })
      .then(setData).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, []);
  const attentionIds = new Set(data?.attention.map(a => a.id));
  return <div className="luxia-dashboard">
    <header className="luxia-page-header">
      <h1>Vue d’ensemble</h1>
      {data && <p>{data.organization.name}, environnement {data.tenant.name}. Mis à jour le {new Date(data.asOf).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}.</p>}
    </header>
    {failed ? <p role="alert" className="posture-alert">Impossible de charger les données. Réessayez dans quelques instants.</p>
      : !data ? <p role="status" className="posture-muted">Chargement...</p> : <>
      <section className="luxia-panel posture-attention" aria-label="À traiter">
        <header><h2><AlertTriangle size={18} aria-hidden /> À traiter</h2></header>
        {data.attention.length === 0
          ? <p className="posture-muted">Aucun point à traiter.</p>
          : <ul>{data.attention.map(a => <li key={a.id}><b>{fr(a.count)}</b><span>{LABELS[a.id]}</span>
              {DRILL[a.id] && <Link href={DRILL[a.id]!}>Voir</Link>}</li>)}</ul>}
      </section>
      {(Object.keys(SECTIONS) as SectionId[]).map(id => {
        const widgets = data.sections[id];
        const visible = widgets.filter((w): w is Exclude<Widget, { state: "restricted" }> => w.state !== "restricted");
        const hidden = widgets.length - visible.length;
        const { title, icon: Icon } = SECTIONS[id];
        return <section className="luxia-panel posture-section" key={id} aria-label={title}>
          <header><h2><Icon size={18} aria-hidden /> {title}</h2></header>
          {visible.length > 0 && <div className="posture-grid">{visible.map(w => <WidgetCard key={w.id} widget={w} attention={attentionIds.has(w.id)} />)}</div>}
          {hidden > 0 && <p className="posture-muted">{visible.length === 0 ? "Vous n’avez pas accès à cette section." : `${hidden} indicateur${hidden > 1 ? "s" : ""} masqué${hidden > 1 ? "s" : ""} (droits insuffisants).`}</p>}
        </section>;
      })}
    </>}
  </div>;
}
