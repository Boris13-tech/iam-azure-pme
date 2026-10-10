"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, Boxes, KeyRound, Scale, ShieldCheck, Users } from "lucide-react";
import { breakdownTotal, type ActivityEntry, type Breakdown, type PostureResponse, type SectionId, type Widget, type WidgetId } from "../../lib/dashboard/posture-contract";

// Identity Security Posture — real canonical data only. No score, no estimate.
// 0 = real zero · Indisponible = unavailable · Non disponible = not implemented · masqué = restricted.

const SECTIONS: Record<SectionId, { title: string; question: string; icon: typeof Users }> = {
  identity: { title: "Identités", question: "Qui existe ?", icon: Users },
  sessions: { title: "Sessions & authentification", question: "Qui est authentifié ?", icon: KeyRound },
  access: { title: "Accès", question: "Qui a accès à quoi ?", icon: ShieldCheck },
  resources: { title: "Ressources", question: "Quelles ressources sont protégées ?", icon: Boxes },
  governance: { title: "Gouvernance", question: "Quelle action de gouvernance est attendue ?", icon: Scale },
  activity: { title: "Activité de sécurité récente", question: "Que s’est-il passé ?", icon: Activity },
};

const LABELS: Record<WidgetId, string> = {
  "identity.subjectsByLifecycle": "Sujets par cycle de vie",
  "identity.subjectsByType": "Sujets par type",
  "identity.accountsByProvider": "Comptes d’identité par fournisseur et statut",
  "identity.recoveryRequiredSubjects": "Sujets en récupération requise",
  "identity.activeSubjectsWithoutActiveAccount": "Sujets actifs sans compte d’identité actif",
  "identity.unresolvedProviderCollisions": "Collisions d’identité fournisseur non résolues",
  "sessions.active": "Sessions actives",
  "sessions.activeSubjects": "Sujets avec une session active",
  "sessions.activeByProvider": "Sessions actives par fournisseur",
  "sessions.started24h": "Sessions ouvertes (24 h)",
  "sessions.started7d": "Sessions ouvertes (7 j)",
  "sessions.revoked7d": "Sessions révoquées (7 j)",
  "auth.localAuthenticatorsByStatus": "Authentificateurs LUXIA_LOCAL par type et statut",
  "auth.compromisedLocalAuthenticators": "Authentificateurs locaux compromis",
  "auth.lockedLocalIdentities": "Identités locales verrouillées ou en récupération",
  "auth.pendingCredentialReenrollments": "Ré-enrôlements d’identifiants en attente",
  "auth.localSignInEvidence7d": "Preuves de connexion LUXIA_LOCAL (7 j)",
  "auth.entraSignInEvidence": "Preuves de connexion Microsoft Entra",
  "auth.entraMfaConditionalAccess": "MFA / accès conditionnel Entra",
  "access.effectiveAssignments": "Assignations effectives",
  "access.effectiveHolders": "Détenteurs d’accès effectifs",
  "access.effectiveBySource": "Assignations effectives par source",
  "access.timeBoundVsPermanent": "Accès bornés dans le temps / permanents",
  "access.administrativeEntitlementHolders": "Détenteurs de droits d’administration",
  "access.nonActiveSubjectsWithEffectiveAccess": "Sujets non actifs disposant encore d’un accès effectif",
  "access.expiringWithin7d": "Accès expirant sous 7 jours",
  "access.activeRowsPastValidity": "Assignations « actives » dont la validité est terminée",
  "access.effectiveLegacyRoleAssignments": "Accès effectifs issus de rôles hérités",
  "resources.activeByType": "Ressources actives par type",
  "resources.activeScopesByKind": "Périmètres actifs par nature",
  "resources.activeScopedEntitlements": "Entitlements de ressource actifs",
  "resources.withoutEffectiveHolder": "Ressources protégées sans aucun détenteur effectif",
  "resources.providerBoundVsNative": "Ressources liées à un fournisseur / natives",
  "governance.sodPoliciesByStatus": "Politiques SoD par statut",
  "governance.sodEnabledRules": "Règles SoD activées",
  "governance.sodDeniedAttempts30d": "Attributions refusées par SoD (30 j)",
  "governance.sodExistingViolations": "Conflits SoD parmi les accès existants",
  "governance.reviewCampaignsByStatus": "Campagnes de revue par statut",
  "governance.overdueReviewCampaigns": "Campagnes de revue en retard",
  "governance.pendingReviewItems": "Éléments de revue en attente",
  "governance.reviewItemsRequiringRemediation": "Éléments de revue à remédier",
  "governance.myPendingReviewDecisions": "Mes décisions de revue en attente",
  "activity.recentChangesAndDenials": "Derniers changements et refus",
  "activity.deniedOrFailed24h": "Refus ou échecs (24 h)",
  "activity.deniedOrFailed7d": "Refus ou échecs (7 j)",
  "activity.privilegedChanges7d": "Changements privilégiés (7 j)",
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
  QUERY_FAILED: "La donnée n’a pas pu être lue. Aucune valeur estimée n’est affichée.",
  ENTRA_EVIDENCE_NOT_RECORDED: "Les connexions Entra ne sont pas encore enregistrées comme preuves canoniques.",
  REQUIRES_PROVIDER_GRAPH_INTEGRATION: "Nécessite l’intégration Microsoft Graph (gestion des fournisseurs).",
  SOD_ENGINE_IS_PREVENTIVE_ONLY: "Le moteur SoD bloque les nouveaux conflits ; la détection des conflits existants n’est pas encore disponible.",
};

const fr = (n: number) => n.toLocaleString("fr-FR");

function BreakdownView({ id, value }: { id: WidgetId; value: Breakdown }) {
  const entries = Object.entries(value);
  const nonZero = entries.filter(([, n]) => n > 0);
  // Overlapping categories (subset, or one holder per right) are never summed.
  const total = breakdownTotal(id, value);
  return <div className="posture-breakdown">{total === null ? <small>Catégories non cumulables</small> : <strong>{fr(total)}</strong>}
    {nonZero.length > 0 && <ul>{nonZero.map(([k, n]) => <li key={k}><span>{k.replaceAll("_", " ").replaceAll(".", " · ")}</span><b>{fr(n)}</b></li>)}</ul>}
    {nonZero.length < entries.length && <small>{nonZero.length ? "Autres catégories : 0" : "Toutes les catégories : 0"}</small>}
  </div>;
}

function ActivityView({ value }: { value: readonly ActivityEntry[] }) {
  if (value.length === 0) return <p className="posture-muted">Aucun changement ni refus enregistré.</p>;
  return <ul className="posture-activity">{value.map(e => <li key={e.id}>
    <span className={e.result === "SUCCESS" ? "ok" : "danger"} aria-hidden />
    <div><b>{e.operation}</b><small>{e.result}{e.actorName ? ` · par ${e.actorName}` : ""}{e.targetName ? ` · cible ${e.targetName}` : ""}</small></div>
    <time dateTime={e.occurredAt}>{new Date(e.occurredAt).toLocaleString("fr-FR")}</time></li>)}</ul>;
}

function WidgetCard({ widget, attention }: { widget: Exclude<Widget, { state: "restricted" }>; attention: boolean }) {
  const href = DRILL[widget.id];
  const body = widget.state === "ok"
    ? typeof widget.value === "number" ? <strong className="posture-number">{fr(widget.value)}</strong>
      : Array.isArray(widget.value) ? <ActivityView value={widget.value as readonly ActivityEntry[]} />
      : <BreakdownView id={widget.id} value={widget.value as Breakdown} />
    : widget.state === "unavailable" ? <p className="posture-state unavailable"><b>Indisponible</b><small>{REASONS[widget.reason] ?? widget.reason}</small></p>
    : <p className="posture-state not-implemented"><b>Non disponible dans cette version</b><small>{REASONS[widget.reason] ?? widget.reason}</small></p>;
  const flagged = attention && widget.state === "ok" && typeof widget.value === "number" && widget.value > 0;
  return <article className={`posture-widget${flagged ? " is-attention" : ""}${widget.id === "activity.recentChangesAndDenials" ? " is-wide" : ""}`}>
    <header><h3>{LABELS[widget.id]}</h3>{href && <Link href={href}>Détail</Link>}</header>{body}
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
    <section className="luxia-hero"><div className="luxia-hero-copy">
      <small>LUXIA IDENTITY · POSTURE DE SÉCURITÉ DES IDENTITÉS</small>
      <h1>{data ? `${data.organization.name} — ${data.tenant.name}` : "Posture de sécurité des identités"}</h1>
      <p>Données canoniques réelles de votre tenant, sans score ni estimation. Les indicateurs visibles dépendent de vos droits.
        {data && <> Données au {new Date(data.asOf).toLocaleString("fr-FR")}.</>}</p>
    </div></section>
    {failed ? <p role="alert" className="posture-alert">Les données sont indisponibles. Aucun indicateur estimé n’est affiché.</p>
      : !data ? <p role="status">Chargement des données du tenant…</p> : <>
      <section className="luxia-panel posture-attention" aria-label="Points d’attention">
        <header><h2><AlertTriangle size={15} /> Points d’attention</h2></header>
        {data.attention.length === 0
          ? <p className="posture-muted">Aucun point d’attention détecté sur les données visibles pour votre compte.</p>
          : <ul>{data.attention.map(a => <li key={a.id}><b>{fr(a.count)}</b><span>{LABELS[a.id]}</span>
              {DRILL[a.id] && <Link href={DRILL[a.id]!}>Voir</Link>}</li>)}</ul>}
      </section>
      {(Object.keys(SECTIONS) as SectionId[]).map(id => {
        const widgets = data.sections[id];
        const visible = widgets.filter((w): w is Exclude<Widget, { state: "restricted" }> => w.state !== "restricted");
        const hidden = widgets.length - visible.length;
        const { title, question, icon: Icon } = SECTIONS[id];
        return <section className="luxia-panel posture-section" key={id} aria-label={title}>
          <header><h2><Icon size={15} /> {title} <small>{question}</small></h2></header>
          {visible.length > 0 && <div className="posture-grid">{visible.map(w => <WidgetCard key={w.id} widget={w} attention={attentionIds.has(w.id)} />)}</div>}
          {hidden > 0 && <p className="posture-muted">{visible.length === 0 ? "Section masquée : " : ""}{hidden} indicateur{hidden > 1 ? "s" : ""} masqué{hidden > 1 ? "s" : ""} faute de droits.</p>}
        </section>;
      })}
    </>}
  </div>;
}
