"use client";
import { useCallback, useEffect, useState } from "react";
type Rule = { id: string; entitlementAId: string; entitlementBId: string; enabled: boolean };
type Policy = { id: string; key: string; scopeId: string; status: "ACTIVE" | "DISABLED"; rules: Rule[] };
type Conflict = { id: string; occurredAt: string; metadata: unknown };
export default function SoDConsole() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(""); const [scopeId, setScope] = useState("");
  const [policyId, setPolicy] = useState(""); const [a, setA] = useState(""); const [b, setB] = useState("");
  const api = useCallback(async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`/api/canonical/sod/${path}`, { method, headers: { "Content-Type": "application/json", "x-luxia-change-id": `sod-ui:${crypto.randomUUID()}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error("Opération refusée ou indisponible. Vérifiez vos droits et le périmètre choisi.");
    return response.json();
  }, []);
  const refresh = useCallback(async () => { const [p, c] = await Promise.all([api("policies"), api("conflicts")]); setPolicies(p); setConflicts(c); }, [api]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError(""); try { await api(path, method, body); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { refresh().catch(e => setError(e.message)); }, [refresh]);
  return <section className="space-y-6 p-6">
    <h1 className="text-2xl font-semibold text-slate-900">Séparation des tâches</h1>
    <p className="text-base text-slate-600">Empêchez qu’une même personne détienne deux droits incompatibles.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void mutate("policies", "POST", { key, scopeId }); }}>
      <input aria-label="Nom de la politique" required value={key} onChange={e => setKey(e.target.value)} placeholder="Nom de la politique" className="border p-2" />
      <input aria-label="Identifiant du périmètre" required value={scopeId} onChange={e => setScope(e.target.value)} placeholder="Identifiant du périmètre" className="border p-2" />
      <button disabled={busy} className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong">Créer la politique (désactivée)</button>
    </form>
    <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void mutate(`policies/${policyId}/rules`, "POST", { entitlementAId: a, entitlementBId: b }); }}>
      <select aria-label="Politique" required value={policyId} onChange={e => setPolicy(e.target.value)} className="border p-2"><option value="">Choisir une politique</option>{policies.map(p => <option key={p.id} value={p.id}>{p.key}</option>)}</select>
      <input aria-label="Premier droit" required value={a} onChange={e => setA(e.target.value)} placeholder="Identifiant du premier droit" className="border p-2" />
      <input aria-label="Second droit" required value={b} onChange={e => setB(e.target.value)} placeholder="Identifiant du second droit" className="border p-2" />
      <button disabled={busy} className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong">Ajouter une incompatibilité</button>
    </form>
    <h2 className="text-xl font-semibold">Politiques</h2>
    {!policies.length && <p>Aucune politique.</p>}
    {policies.map(p => <article key={p.id} className="rounded border bg-white p-4">
      <h3>{p.key} ({p.status === "ACTIVE" ? "active" : "désactivée"})</h3><p>Périmètre : {p.scopeId}</p>
      <button disabled={busy} onClick={() => void mutate(`policies/${p.id}`, "PATCH", { status: p.status === "ACTIVE" ? "DISABLED" : "ACTIVE" })} className="border p-2">{p.status === "ACTIVE" ? "Désactiver" : "Activer"}</button>
      {p.rules.map(r => <div key={r.id} className="mt-2">{r.entitlementAId} + {r.entitlementBId} : {r.enabled ? "exclusion active" : "règle désactivée"}
        {r.enabled && <button disabled={busy} onClick={() => void mutate(`rules/${r.id}`, "DELETE")} className="ml-3 border p-2">Désactiver la règle</button>}</div>)}
    </article>)}
    <h2 className="text-xl font-semibold">Attributions bloquées</h2>
    {!conflicts.length && <p>Aucune attribution bloquée.</p>}
    {conflicts.map(c => <article key={c.id} className="rounded border p-3"><time>{c.occurredAt}</time><pre className="overflow-auto">{JSON.stringify(c.metadata, null, 2)}</pre></article>)}
  </section>;
}
