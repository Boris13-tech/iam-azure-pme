"use client";
import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck, History, ListChecks } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";

// Access reviews. A reviewer decides on each access in words: who holds it, which entitlement, on which resources.
// Names are read with the viewer's own rights (subjects, entitlements, resources); without them the line says so
// instead of showing identifiers. Same API as before (/api/canonical/access-reviews).
type Campaign = { id: string; name: string; scopeType: string; status: string; dueAt: string; reviewerSubjectId: string };
type Item = { id: string; subjectId: string; assignmentId: string; entitlementId: string; resourceIds: string[]; reviewerSubjectId: string; decision: string; reviewState: string; justification: string | null };
type Configuration = { scopes: { id: string; key: string; kind: string; resource?: { name: string } | null }[]; reviewers: { id: string; name: string }[] };
type AuditEvent = { id: string; operation: string; result: string; occurredAt: string };

const ERRORS: Record<string, string> = {
  FORBIDDEN: "Vous n’avez pas le droit d’effectuer cette action.", NOT_FOUND: "Élément introuvable ou non visible pour vous.",
  REVIEW_IMMUTABLE: "Cette décision ne peut plus être modifiée.", SELF_REVIEW_FORBIDDEN: "Un réviseur ne peut pas examiner ses propres accès.",
  CAMPAIGN_INCOMPLETE: "Toutes les décisions doivent être prises avant la clôture.", VALIDATION_FAILED: "Vérifiez les champs saisis.",
};
class Refused extends Error {}
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/canonical/access-reviews${path}`, { cache: "no-store", ...(body ? { method: "POST", headers: { "content-type": "application/json", "x-luxia-change-id": `review-ui:${crypto.randomUUID()}` }, body: JSON.stringify(body) } : {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Refused(ERRORS[value.error] ?? (response.status === 403 ? ERRORS.FORBIDDEN : "Opération impossible pour le moment. Réessayez."));
  return value;
}
async function names(url: string, pick: (row: Record<string, unknown>) => [string, string]) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return new Map<string, string>();
    return new Map((await response.json() as Record<string, unknown>[]).map(pick));
  } catch { return new Map<string, string>(); }
}
const SCOPE_KINDS: Record<string, string> = { RESOURCE: "ressource unique", RESOURCE_GROUP: "groupe de ressources", TENANT: "environnement entier" };
const DECISIONS: Record<string, string> = { PENDING: "En attente", KEEP: "Accès conservé", REVOKE: "Accès retiré" };
const REVIEW_STATES: Record<string, string> = { PENDING: "à examiner", REQUIRES_REMEDIATION: "à corriger", DECIDED: "décidé" };
const REVIEW_EVENTS: Record<string, string> = { "ACCESS_REVIEW.CAMPAIGN.CREATE": "Campagne créée", "ACCESS_REVIEW.CAMPAIGN.COMPLETE": "Campagne clôturée",
  "ACCESS_REVIEW.ITEM.KEEP": "Accès conservé", "ACCESS_REVIEW.ITEM.REVOKE": "Accès retiré" };
const RESULTS: Record<string, string> = { SUCCESS: "réussi", DENIED: "refusé", FAILURE: "échec" };
const when = (value: string) => new Date(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export default function ReviewConsole() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null), [selected, setSelected] = useState<Campaign | null>(null);
  const [items, setItems] = useState<Item[] | null>(null), [audit, setAudit] = useState<AuditEvent[]>([]);
  const [configuration, setConfiguration] = useState<Configuration | null>(null), [permissions, setPermissions] = useState<string[]>([]), [actor, setActor] = useState("");
  const [name, setName] = useState(""), [scopeId, setScope] = useState(""), [reviewerSubjectId, setReviewer] = useState(""), [dueAt, setDue] = useState("");
  const [pending, setPending] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [loadFailed, setLoadFailed] = useState(false);
  const [justifications, setJustifications] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState({ people: new Map<string, string>(), rights: new Map<string, string>(), resources: new Map<string, string>() });

  const load = async () => setCampaigns(await api(""));
  const start = async () => {
    setLoadFailed(false); setError("");
    try {
      const platform = await (await fetch("/api/platform/context", { cache: "no-store" })).json();
      setPermissions(platform.entitlements ?? []); setActor(platform.subject?.id ?? "");
      if ((platform.entitlements ?? []).includes("access_reviews.create")) setConfiguration(await api("/configuration"));
      await load();
      // Labels one at a time, after the campaigns: each request holds a database connection on the server.
      const people = await names("/api/canonical/subjects", r => [String(r.id), String(r.name)]);
      const rights = await names("/api/canonical/resource-governance/entitlements", r => [String(r.id), String(r.description || r.key)]);
      const resources = await names("/api/canonical/resources", r => [String(r.id), String(r.name)]);
      setLabels({ people, rights, resources });
    } catch (failure) { setLoadFailed(true); setError(failure instanceof Error ? failure.message : ""); }
  };
  useEffect(() => { void start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = async (campaign: Campaign, onlyPending = pending) => {
    setSelected(await api(`/${campaign.id}`)); setItems(null);
    setItems(await api(`/${campaign.id}/items${onlyPending ? "?pending=true" : ""}`));
    setAudit(await api(`/${campaign.id}/audit`));
  };
  const execute = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Opération impossible pour le moment."); }
    finally { setBusy(false); }
  };
  const person = (id: string) => labels.people.get(id) ?? "Personne (nom non visible avec vos droits)";
  const right = (id: string) => labels.rights.get(id) ?? "Droit (libellé non visible avec vos droits)";
  const resourceList = useMemo(() => (ids: string[]) => ids.length === 0 ? "aucune" : ids.map(id => labels.resources.get(id) ?? "ressource non visible").join(", "), [labels]);

  return <div className="luxia-dashboard">
    <PageHeader title="Revues d’accès" description="Vérifiez régulièrement que chaque accès est toujours justifié. Conserver maintient l’accès ; Retirer le supprime sur toutes ses ressources." />
    {error && !loadFailed && <p role="alert" className="lx-alert lx-alert--danger mb-4">{error}</p>}

    {configuration && <section className="luxia-panel posture-section" aria-label="Créer une campagne">
      <header><h2><ClipboardCheck size={18} aria-hidden /> Créer une campagne</h2></header>
      <form className="lx-form-row" onSubmit={event => { event.preventDefault(); void execute(async () => {
        const result = await api("", { name, scopeId, reviewerSubjectId, startsAt: new Date().toISOString(), dueAt: new Date(dueAt).toISOString() });
        await load(); await detail(result); setName("");
      }); }}>
        <div className="lx-field"><label htmlFor="review-name" className="lx-label">Nom</label>
          <input id="review-name" className="lx-input" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="par exemple Revue trimestrielle" /></div>
        <div className="lx-field"><label htmlFor="review-scope" className="lx-label">Périmètre</label>
          <select id="review-scope" className="lx-select" required value={scopeId} onChange={event => setScope(event.target.value)}><option value="">Choisir un périmètre</option>
            {configuration.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.resource?.name ?? scope.key} ({SCOPE_KINDS[scope.kind] ?? scope.kind})</option>)}</select></div>
        <div className="lx-field"><label htmlFor="review-reviewer" className="lx-label">Réviseur</label>
          <select id="review-reviewer" className="lx-select" required value={reviewerSubjectId} onChange={event => setReviewer(event.target.value)}><option value="">Choisir un réviseur</option>
            {configuration.reviewers.map(reviewer => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}</select></div>
        <div className="lx-field"><label htmlFor="review-due" className="lx-label">Échéance</label>
          <input id="review-due" className="lx-input" type="datetime-local" required value={dueAt} onChange={event => setDue(event.target.value)} /></div>
        <button disabled={busy} className="lx-btn lx-btn--primary">Créer la campagne</button>
      </form>
      <p className="lx-meta px-4 pb-4">Un réviseur ne peut pas examiner ses propres accès. Une campagne couvre au maximum 1 000 accès.</p>
    </section>}

    <section className="luxia-panel posture-section" aria-label="Campagnes">
      <header><h2><ListChecks size={18} aria-hidden /> Campagnes</h2></header>
      {loadFailed ? <ErrorState onRetry={() => void start()}>{error || "Les campagnes sont indisponibles."}</ErrorState>
        : campaigns === null ? <LoadingState label="Chargement des campagnes..." />
        : campaigns.length === 0 ? <EmptyState>Aucune campagne.</EmptyState>
        : <ul className="lx-list">{campaigns.map(campaign => <li key={campaign.id}>
            <div className="min-w-0"><p className="m-0 font-semibold">{campaign.name}</p>
              <p className="lx-meta">Échéance le {when(campaign.dueAt)}</p></div>
            <span className={`lx-pill${campaign.status === "OPEN" ? " lx-pill--warn" : " lx-pill--on"}`}>{campaign.status === "OPEN" ? "En cours" : "Terminée"}</span>
            <button type="button" disabled={busy} aria-pressed={selected?.id === campaign.id} className="lx-btn lx-btn--secondary lx-btn--small" onClick={() => void execute(() => detail(campaign))}>Ouvrir</button>
          </li>)}</ul>}
      {campaigns && campaigns.length > 0 && campaigns.length % 100 === 0 && <div className="p-4"><button type="button" disabled={busy} className="lx-btn lx-btn--secondary lx-btn--small" onClick={() => void execute(async () => setCampaigns([...campaigns, ...await api(`?after=${campaigns[campaigns.length - 1].id}`)]))}>Afficher plus</button></div>}
    </section>

    {selected && <section className="luxia-panel posture-section" aria-label={`Campagne ${selected.name}`}>
      <header><h2><ClipboardCheck size={18} aria-hidden /> {selected.name}</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pending} onChange={event => { const value = event.target.checked; setPending(value); void execute(() => detail(selected, value)); }} /> Mes décisions en attente</label>
      </header>
      {items === null ? <LoadingState label="Chargement des accès à examiner..." /> : items.length === 0 ? <EmptyState>Aucun accès à examiner.</EmptyState> : <ul className="lx-list">
        {items.map(item => <li key={item.id}>
          <div className="min-w-0 flex-1">
            <p className="m-0 font-semibold">{person(item.subjectId)}</p>
            <p className="lx-meta">Droit : {right(item.entitlementId)} · Ressources : {resourceList(item.resourceIds)}</p>
            <p className="lx-meta">{DECISIONS[item.decision] ?? item.decision}, {REVIEW_STATES[item.reviewState] ?? item.reviewState}{item.justification ? ` · « ${item.justification} »` : ""}</p>
            {item.decision === "PENDING" && item.reviewerSubjectId === actor && permissions.includes("access_reviews.decide") && selected.status === "OPEN" && <div className="mt-3 lx-stack">
              <div className="lx-field"><label htmlFor={`justification-${item.id}`} className="lx-label">Justification (aucun mot de passe ni secret)</label>
                <textarea id={`justification-${item.id}`} minLength={3} maxLength={2000} rows={2} className="lx-input" style={{ height: "auto", padding: "10px 14px" }}
                  value={justifications[item.id] ?? ""} onChange={event => setJustifications({ ...justifications, [item.id]: event.target.value })} /></div>
              <div className="flex flex-wrap gap-2">{(["KEEP", "REVOKE"] as const).map(decision => <button key={decision} type="button"
                disabled={busy || (justifications[item.id] ?? "").trim().length < 3} className={`lx-btn lx-btn--small ${decision === "KEEP" ? "lx-btn--primary" : "lx-btn--secondary"}`}
                onClick={() => void execute(async () => { await api(`/${selected.id}/items/${item.id}/decision`, { decision, justification: justifications[item.id] }); await detail(selected); })}>
                {decision === "KEEP" ? "Conserver l’accès" : "Retirer l’accès"}</button>)}</div>
            </div>}
          </div>
        </li>)}
      </ul>}
      {items && items.length > 0 && items.length % 100 === 0 && <div className="p-4"><button type="button" disabled={busy} className="lx-btn lx-btn--secondary lx-btn--small" onClick={() => void execute(async () => setItems([...items, ...await api(`/${selected.id}/items?after=${items[items.length - 1].id}${pending ? "&pending=true" : ""}`)]))}>Afficher plus</button></div>}
      {selected.status === "OPEN" && permissions.includes("access_reviews.manage") && <div className="p-4"><button type="button" disabled={busy} className="lx-btn lx-btn--secondary lx-btn--small"
        onClick={() => void execute(async () => { await api(`/${selected.id}/complete`, {}); await load(); await detail(selected); })}>Clôturer la campagne</button>
        <p className="lx-meta">Toutes les décisions doivent être prises avant la clôture.</p></div>}
      <h3 className="flex items-center gap-2 px-4 pt-2 text-sm font-semibold"><History size={16} aria-hidden /> Historique</h3>
      {audit.length === 0 ? <EmptyState>Aucun événement.</EmptyState> : <ul className="lx-list">{audit.map(event => <li key={event.id}>
        <span>{REVIEW_EVENTS[event.operation] ?? event.operation} ({RESULTS[event.result] ?? event.result})</span><time className="lx-meta" dateTime={event.occurredAt}>{when(event.occurredAt)}</time></li>)}</ul>}
      {audit.length > 0 && audit.length % 100 === 0 && <div className="p-4"><button type="button" disabled={busy} className="lx-btn lx-btn--secondary lx-btn--small" onClick={() => void execute(async () => setAudit([...audit, ...await api(`/${selected.id}/audit?after=${audit[audit.length - 1].id}`)]))}>Afficher plus</button></div>}
    </section>}
  </div>;
}
