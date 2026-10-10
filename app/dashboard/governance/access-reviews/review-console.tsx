"use client";
import { useEffect, useState } from "react";

type Campaign = { id: string; name: string; scopeType: string; status: string; dueAt: string; reviewerSubjectId: string };
type Item = { id: string; subjectId: string; assignmentId: string; entitlementId: string; resourceIds: string[]; reviewerSubjectId: string; decision: string; reviewState: string; justification: string | null };
type Configuration = { scopes: { id: string; key: string; kind: string }[]; reviewers: { id: string; name: string }[] };
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/canonical/access-reviews${path}`, { cache: "no-store", ...(body ? { method: "POST", headers: { "content-type": "application/json", "x-luxia-change-id": `review-ui:${crypto.randomUUID()}` }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "REQUEST_DENIED");
  return value;
}
export default function ReviewConsole() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]), [selected, setSelected] = useState<Campaign | null>(null);
  const [items, setItems] = useState<Item[]>([]), [audit, setAudit] = useState<{ id: string; operation: string; result: string; occurredAt: string }[]>([]);
  const [configuration, setConfiguration] = useState<Configuration | null>(null), [permissions, setPermissions] = useState<string[]>([]), [actor, setActor] = useState("");
  const [name, setName] = useState(""), [scopeId, setScope] = useState(""), [reviewerSubjectId, setReviewer] = useState(""), [dueAt, setDue] = useState("");
  const [pending, setPending] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [justifications, setJustifications] = useState<Record<string, string>>({});
  const load = async () => setCampaigns(await api(""));
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const platform = await (await fetch("/api/platform/context", { cache: "no-store" })).json();
        if (!active) return;
        setPermissions(platform.entitlements ?? []); setActor(platform.subject?.id ?? "");
        if ((platform.entitlements ?? []).includes("access_reviews.create")) setConfiguration(await api("/configuration"));
        await load();
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : "REQUEST_DENIED"); }
    })();
    return () => { active = false; };
  }, []);
  const detail = async (campaign: Campaign, onlyPending = pending) => {
    setSelected(await api(`/${campaign.id}`));
    setItems(await api(`/${campaign.id}/items${onlyPending ? "?pending=true" : ""}`));
    setAudit(await api(`/${campaign.id}/audit`));
  };
  const execute = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : "REQUEST_DENIED"); }
    finally { setBusy(false); }
  };
  return <section className="p-6 space-y-5">
    <h1 className="text-2xl font-semibold text-slate-900">Revues d’accès</h1>
    <p className="text-base text-slate-600">Vérifiez régulièrement que chaque accès est toujours justifié. Conserver maintient l’accès, Retirer le supprime sur toutes ses ressources.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {configuration && <form className="p-4 border rounded bg-white space-y-3" onSubmit={event => { event.preventDefault(); void execute(async () => {
      const result = await api("", { name, scopeId, reviewerSubjectId, startsAt: new Date().toISOString(), dueAt: new Date(dueAt).toISOString() });
      await load(); await detail(result); setName("");
    }); }}>
      <h2 className="font-bold">Créer une campagne</h2>
      <input aria-label="Nom de la campagne" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Nom de la campagne" className="border p-2" />
      <select aria-label="Périmètre" required value={scopeId} onChange={event => setScope(event.target.value)} className="border p-2"><option value="">Choisir un périmètre</option>{configuration.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.key} ({scope.kind})</option>)}</select>
      <select aria-label="Réviseur" required value={reviewerSubjectId} onChange={event => setReviewer(event.target.value)} className="border p-2"><option value="">Choisir un réviseur</option>{configuration.reviewers.map(reviewer => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}</select>
      <label>Échéance <input type="datetime-local" required value={dueAt} onChange={event => setDue(event.target.value)} className="border p-2" /></label>
      <button disabled={busy} className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong">Créer la campagne</button>
      <p className="text-sm text-slate-600">Un réviseur ne peut pas examiner ses propres accès. Une campagne couvre au maximum 1 000 accès.</p>
    </form>}
    <div className="space-y-2"><h2 className="font-bold">Campagnes</h2>{campaigns.length === 0 && <p>Aucune campagne.</p>}
      {campaigns.map(campaign => <button key={campaign.id} disabled={busy} onClick={() => void execute(() => detail(campaign))} className="block p-3 border bg-white rounded"><span className="font-medium">{campaign.name}</span> <span className="text-slate-600">{campaign.status === "OPEN" ? "En cours" : "Terminée"}, échéance le {new Date(campaign.dueAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span></button>)}
      {campaigns.length > 0 && campaigns.length % 100 === 0 && <button disabled={busy} onClick={() => void execute(async () => setCampaigns([...campaigns, ...await api(`?after=${campaigns[campaigns.length - 1].id}`)]))}>Afficher plus</button>}
    </div>
    {selected && <div className="space-y-3"><h2 className="text-xl font-bold">{selected.name}</h2>
      <label><input type="checkbox" checked={pending} onChange={event => { const value = event.target.checked; setPending(value); void execute(() => detail(selected, value)); }} /> Mes décisions en attente</label>
      {items.length === 0 && <p>Aucun accès à examiner.</p>}
      {items.map(item => <article key={item.id} className="border rounded p-4 bg-white space-y-2">
        <p>Identité : {item.subjectId}</p><p>Accès : {item.assignmentId}</p><p>Droit : {item.entitlementId}</p>
        <p>Ressources couvertes : {item.resourceIds.join(", ")}</p><p>Décision : {item.decision}. État : {item.reviewState}.</p>
        {item.justification && <p>Justification : {item.justification}</p>}
        {item.decision === "PENDING" && item.reviewerSubjectId === actor && permissions.includes("access_reviews.decide") && selected.status === "OPEN" && <>
          <label>Justification (ne saisissez aucun mot de passe ni secret)<textarea minLength={3} maxLength={2000} value={justifications[item.id] ?? ""} onChange={event => setJustifications({ ...justifications, [item.id]: event.target.value })} className="block border w-full p-2" /></label>
          {(["KEEP", "REVOKE"] as const).map(decision => <button key={decision} disabled={busy || (justifications[item.id] ?? "").trim().length < 3} className="border rounded p-2 mr-2" onClick={() => void execute(async () => {
            await api(`/${selected.id}/items/${item.id}/decision`, { decision, justification: justifications[item.id] }); await detail(selected);
          })}>{decision === "KEEP" ? "Conserver l’accès" : "Retirer l’accès"}</button>)}
        </>}
      </article>)}
      {items.length > 0 && items.length % 100 === 0 && <button disabled={busy} onClick={() => void execute(async () => setItems([...items, ...await api(`/${selected.id}/items?after=${items[items.length - 1].id}${pending ? "&pending=true" : ""}`)]))}>Afficher plus</button>}
      {selected.status === "OPEN" && permissions.includes("access_reviews.manage") && <button disabled={busy} className="p-2 border rounded" onClick={() => void execute(async () => { await api(`/${selected.id}/complete`, {}); await load(); await detail(selected); })}>Clôturer la campagne (toutes les décisions doivent être prises)</button>}
      <h3 className="font-bold">Historique</h3>{audit.map(event => <p key={event.id}>{event.operation} ({event.result}), le {new Date(event.occurredAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</p>)}
      {audit.length > 0 && audit.length % 100 === 0 && <button disabled={busy} onClick={() => void execute(async () => setAudit([...audit, ...await api(`/${selected.id}/audit?after=${audit[audit.length - 1].id}`)]))}>Afficher plus</button>}
    </div>}
  </section>;
}
