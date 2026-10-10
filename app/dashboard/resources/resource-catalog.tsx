"use client";
import { useCallback, useEffect, useState } from "react";

type Resource = { id: string; name: string; type: string; active: boolean; organizationId: string; tenantId: string };
const base = "/api/canonical/resource-governance/resources";
const categories = [["", "Toutes"], ["APPLICATION", "Applications"], ["API", "API"], ["SERVICE", "Services"], ["DEVICE", "Appareils"], ["WORKLOAD", "Charges de travail"], ["AI_AGENT", "Agents IA"]] as const;

export default function ResourceCatalog() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [selected, setSelected] = useState<Resource | null>(null);
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("APPLICATION");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [hasNext, setHasNext] = useState(false);
  const load = useCallback(async (after?: string) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${base}${after ? `?after=${encodeURIComponent(after)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 ? "Accès au catalogue refusé." : "Catalogue indisponible.");
      const rows: Resource[] = await response.json();
      setResources(previous => after ? [...previous, ...rows] : rows); setHasNext(rows.length === 100);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Chargement impossible."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    // Existing context API reports persisted canonical entitlements, not a client-side role guess.
    void fetch("/api/platform/context", { cache: "no-store" }).then(async response => {
      if (!response.ok) return;
      const context = await response.json();
      setCanManage(Array.isArray(context.entitlements) && context.entitlements.includes("resources.manage"));
    }).catch(() => setCanManage(false));
  }, [load]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-luxia-change-id": crypto.randomUUID() }, body: JSON.stringify({ name, type }) });
      if (!response.ok) throw new Error(response.status === 403 ? "Création refusée." : "Création impossible.");
      setName(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Création impossible."); }
    finally { setBusy(false); }
  }
  async function detail(id: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${base}/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Lecture refusée ou ressource indisponible.");
      setSelected(await response.json());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Lecture impossible."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-6 p-6">
    <h1 className="text-2xl font-semibold text-slate-900">Ressources</h1>
    {canManage && <a href="/dashboard/resources/onboarding" className="inline-block rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">Attribuer un premier accès</a>}
    <p className="text-base text-slate-600">Applications, API et services enregistrés. Une ressource n’est protégée que si son service interroge LUXIA avant d’autoriser une action.</p>
    <nav aria-label="Types de ressources" className="flex flex-wrap gap-3">{categories.map(([value, label]) => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)} className="rounded border px-3 py-2">{label}</button>)}</nav>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {canManage && <form onSubmit={create} className="flex flex-wrap gap-3">
      <label>Nom <input required maxLength={200} value={name} onChange={event => setName(event.target.value)} className="rounded border p-2" /></label>
      <label>Type <select value={type} onChange={event => setType(event.target.value)} className="rounded border p-2">{categories.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button disabled={busy} className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong">Créer une ressource</button>
    </form>}
    {busy && <p role="status">Chargement...</p>}
    <table className="w-full text-left"><thead><tr><th>Nom</th><th>Type</th><th>État</th><th>Détail</th></tr></thead><tbody>{resources.filter(row => !category || row.type === category).map(row => <tr key={row.id}><td>{row.name}</td><td>{categories.find(([value]) => value === row.type)?.[1] ?? row.type}</td><td>{row.active ? "Active" : "Désactivée"}</td><td><button disabled={busy} onClick={() => detail(row.id)} className="text-accent hover:underline">Voir</button></td></tr>)}</tbody></table>
    {!busy && !resources.length && !error && <p>Aucune ressource enregistrée.</p>}
    {hasNext && <button disabled={busy} onClick={() => load(resources.at(-1)?.id)}>Afficher plus</button>}
    {selected && <article className="rounded border p-4"><h2 className="font-bold">{selected.name}</h2><p>{categories.find(([value]) => value === selected.type)?.[1] ?? selected.type}, {selected.active ? "active" : "désactivée"}</p><p className="text-sm text-slate-600">Identifiant technique : {selected.id}</p></article>}
  </section>;
}
