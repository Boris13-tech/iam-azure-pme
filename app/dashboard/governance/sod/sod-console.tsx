"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Scale, ShieldAlert } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, PageHeader, RestrictedState } from "@/components/ui/states";

// Separation of duties: an administrator chooses a scope and two entitlements from lists (never types identifiers),
// activates the policy, and sees blocked assignments in words. Same API as before (/api/canonical/sod).
type Rule = { id: string; entitlementAId: string; entitlementBId: string; enabled: boolean };
type Policy = { id: string; key: string; scopeId: string; status: "ACTIVE" | "DISABLED"; rules: Rule[] };
type Conflict = { id: string; occurredAt: string; metadata: { subjectId?: string; entitlementId?: string; policyId?: string } | null };
type Scope = { id: string; key: string; kind: string; active: boolean };
type Entitlement = { id: string; key: string; action: string; description: string | null; resourceScopeId: string | null; active: boolean };
type Subject = { id: string; name: string };
type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "restricted" } | { state: "unavailable" };

async function read<T>(url: string): Promise<Load<T>> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 403) return { state: "restricted" };
    if (!response.ok) return { state: "unavailable" };
    return { state: "ok", data: await response.json() as T };
  } catch { return { state: "unavailable" }; }
}
const dateTime = (value: string) => new Date(value).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

export default function SoDConsole() {
  const [policies, setPolicies] = useState<Load<Policy[]>>({ state: "loading" });
  const [conflicts, setConflicts] = useState<Load<Conflict[]>>({ state: "loading" });
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(""); const [scopeId, setScope] = useState("");
  const [policyId, setPolicy] = useState(""); const [a, setA] = useState(""); const [b, setB] = useState("");

  const refresh = useCallback(async () => {
    // At most two requests at a time: each holds a database connection on the server.
    const [p, c] = await Promise.all([read<Policy[]>("/api/canonical/sod/policies"), read<Conflict[]>("/api/canonical/sod/conflicts")]);
    setPolicies(p); setConflicts(c);
    const s = await read<Scope[]>("/api/canonical/resource-governance/scopes");
    const e = await read<Entitlement[]>("/api/canonical/resource-governance/entitlements");
    const people = await read<Subject[]>("/api/canonical/subjects");
    setScopes(s.state === "ok" ? s.data.filter(x => x.active) : []);
    setEntitlements(e.state === "ok" ? e.data.filter(x => x.active) : []);
    setSubjects(people.state === "ok" ? people.data : []);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const scopeLabel = useMemo(() => new Map(scopes.map(s => [s.id, s.key])), [scopes]);
  const entitlementLabel = useMemo(() => new Map(entitlements.map(e => [e.id, e.description || e.key])), [entitlements]);
  const personLabel = useMemo(() => new Map(subjects.map(s => [s.id, s.name])), [subjects]);
  const selectedPolicy = policies.state === "ok" ? policies.data.find(p => p.id === policyId) : undefined;
  // A rule pairs two entitlements of the policy's own scope.
  const ruleChoices = selectedPolicy ? entitlements.filter(e => e.resourceScopeId === selectedPolicy.scopeId) : [];

  async function mutate(path: string, method: string, body: unknown, success: string) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/canonical/sod/${path}`, { method, headers: { "Content-Type": "application/json", "x-luxia-change-id": `sod-ui:${crypto.randomUUID()}` },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        const code = (await response.json().catch(() => ({}))).error;
        throw new Error(code === "SOD_CONFLICT"
          ? "Activation impossible : des personnes détiennent déjà les deux droits incompatibles. Retirez l’un des deux accès à ces personnes, puis réessayez."
          : response.status === 403 ? "Vous n’avez pas le droit d’effectuer cette action." : "Opération refusée. Vérifiez les éléments choisis, puis réessayez.");
      }
      setMessage({ tone: "ok", text: success });
      await refresh();
      return true;
    } catch (error) { setMessage({ tone: "error", text: (error as Error).message }); return false; } finally { setBusy(false); }
  }

  return <div className="luxia-dashboard">
    <PageHeader title="Séparation des tâches" description="Empêchez qu’une même personne détienne deux droits incompatibles sur un même périmètre." />
    {message && <p className={`lx-alert lx-alert--${message.tone === "ok" ? "success" : "danger"} mb-4`} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p>}

    <section className="luxia-panel posture-section" aria-label="Nouvelle politique">
      <header><h2><Scale size={18} aria-hidden /> Nouvelle politique</h2></header>
      <form className="lx-form-row" onSubmit={async e => { e.preventDefault(); if (await mutate("policies", "POST", { key, scopeId }, "Politique créée, désactivée. Ajoutez ses règles, puis activez-la.")) { setKey(""); setScope(""); } }}>
        <div className="lx-field"><label htmlFor="sod-key" className="lx-label">Nom</label>
          <input id="sod-key" className="lx-input" required value={key} onChange={e => setKey(e.target.value)} placeholder="par exemple paiements-validation" pattern="[A-Za-z0-9_.:\-]{1,128}"
            title="Lettres, chiffres, points, deux-points, tirets et soulignés ; 128 caractères au plus" /></div>
        <div className="lx-field"><label htmlFor="sod-scope" className="lx-label">Périmètre</label>
          <select id="sod-scope" className="lx-select" required value={scopeId} onChange={e => setScope(e.target.value)}>
            <option value="">{scopes.length ? "Choisir un périmètre" : "Aucun périmètre disponible"}</option>
            {scopes.map(s => <option key={s.id} value={s.id}>{s.key}</option>)}
          </select></div>
        <button disabled={busy || !scopes.length} className="lx-btn lx-btn--primary">Créer (désactivée)</button>
      </form>
    </section>

    <section className="luxia-panel posture-section" aria-label="Politiques">
      <header><h2><ShieldAlert size={18} aria-hidden /> Politiques</h2></header>
      {policies.state === "loading" && <LoadingState label="Chargement des politiques..." />}
      {policies.state === "restricted" && <RestrictedState />}
      {policies.state === "unavailable" && <ErrorState onRetry={() => void refresh()}>Les politiques sont indisponibles.</ErrorState>}
      {policies.state === "ok" && (policies.data.length === 0 ? <EmptyState>Aucune politique pour le moment.</EmptyState> : <ul className="lx-list">
        {policies.data.map(p => <li key={p.id}>
          <div className="min-w-0">
            <p className="m-0 font-semibold">{p.key} <span className={`lx-pill${p.status === "ACTIVE" ? " lx-pill--on" : ""}`}>{p.status === "ACTIVE" ? "Active" : "Désactivée"}</span></p>
            <p className="lx-meta">Périmètre : {scopeLabel.get(p.scopeId) ?? "périmètre non visible"}</p>
            {p.rules.length === 0 ? <p className="lx-meta">Aucune règle.</p> : <ul className="mt-2 space-y-1">{p.rules.map(r => <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{entitlementLabel.get(r.entitlementAId) ?? "droit non visible"} <b aria-label="incompatible avec">≠</b> {entitlementLabel.get(r.entitlementBId) ?? "droit non visible"}</span>
              <span className={`lx-pill${r.enabled ? " lx-pill--on" : ""}`}>{r.enabled ? "Appliquée" : "Désactivée"}</span>
              {r.enabled && <button type="button" disabled={busy} className="lx-btn lx-btn--secondary lx-btn--small" onClick={() => void mutate(`rules/${r.id}`, "DELETE", undefined, "Règle désactivée.")}>Désactiver la règle</button>}
            </li>)}</ul>}
          </div>
          <button type="button" disabled={busy} className={`lx-btn lx-btn--small ${p.status === "ACTIVE" ? "lx-btn--secondary" : "lx-btn--primary"}`}
            onClick={() => void mutate(`policies/${p.id}`, "PATCH", { status: p.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }, p.status === "ACTIVE" ? "Politique désactivée." : "Politique activée.")}>
            {p.status === "ACTIVE" ? "Désactiver" : "Activer"}</button>
        </li>)}
      </ul>)}
      {policies.state === "ok" && policies.data.length > 0 && <form className="lx-form-row" style={{ borderTop: "1px solid var(--border)" }}
        onSubmit={async e => { e.preventDefault(); if (await mutate(`policies/${policyId}/rules`, "POST", { entitlementAId: a, entitlementBId: b }, "Incompatibilité ajoutée.")) { setA(""); setB(""); } }}>
        <div className="lx-field"><label htmlFor="sod-policy" className="lx-label">Politique</label>
          <select id="sod-policy" className="lx-select" required value={policyId} onChange={e => { setPolicy(e.target.value); setA(""); setB(""); }}>
            <option value="">Choisir une politique</option>{policies.data.map(p => <option key={p.id} value={p.id}>{p.key}</option>)}</select></div>
        <div className="lx-field"><label htmlFor="sod-a" className="lx-label">Premier droit</label>
          <select id="sod-a" className="lx-select" required value={a} onChange={e => setA(e.target.value)} disabled={!selectedPolicy}>
            <option value="">{selectedPolicy && !ruleChoices.length ? "Aucun droit sur ce périmètre" : "Choisir un droit"}</option>
            {ruleChoices.map(e => <option key={e.id} value={e.id}>{e.description || e.key}</option>)}</select></div>
        <div className="lx-field"><label htmlFor="sod-b" className="lx-label">Droit incompatible</label>
          <select id="sod-b" className="lx-select" required value={b} onChange={e => setB(e.target.value)} disabled={!selectedPolicy}>
            <option value="">Choisir un droit</option>
            {ruleChoices.filter(e => e.id !== a).map(e => <option key={e.id} value={e.id}>{e.description || e.key}</option>)}</select></div>
        <button disabled={busy || !a || !b} className="lx-btn lx-btn--primary">Ajouter l’incompatibilité</button>
      </form>}
    </section>

    <section className="luxia-panel posture-section" aria-label="Attributions bloquées">
      <header><h2><Ban size={18} aria-hidden /> Attributions bloquées</h2></header>
      {conflicts.state === "loading" && <LoadingState />}
      {conflicts.state === "restricted" && <RestrictedState />}
      {conflicts.state === "unavailable" && <ErrorState onRetry={() => void refresh()}>La liste des attributions bloquées est indisponible.</ErrorState>}
      {conflicts.state === "ok" && (conflicts.data.length === 0 ? <EmptyState>Aucune attribution bloquée.</EmptyState> : <ul className="lx-list">
        {conflicts.data.map(c => <li key={c.id}>
          <div className="min-w-0">
            <p className="m-0">{personLabel.get(c.metadata?.subjectId ?? "") ?? "Une personne"} ne pouvait pas recevoir
              « {entitlementLabel.get(c.metadata?.entitlementId ?? "") ?? "un droit"} » : incompatible avec un droit déjà détenu.</p>
            <p className="lx-meta"><time dateTime={c.occurredAt}>{dateTime(c.occurredAt)}</time></p>
          </div>
        </li>)}
      </ul>)}
    </section>
  </div>;
}
