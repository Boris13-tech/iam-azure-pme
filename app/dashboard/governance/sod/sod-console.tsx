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
    if (!response.ok) throw new Error("Opération refusée ou indisponible. Vérifiez vos droits et le scope sélectionné.");
    return response.json();
  }, []);
  const refresh = useCallback(async () => { const [p, c] = await Promise.all([api("policies"), api("conflicts")]); setPolicies(p); setConflicts(c); }, [api]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError(""); try { await api(path, method, body); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { refresh().catch(e => setError(e.message)); }, [refresh]);
  return <section className="space-y-6 p-6">
    <h1 className="text-2xl font-semibold">Gouvernance — Séparation des tâches</h1>
    <p>Règles explicites entre deux droits sur des ressources du tenant courant. Aucun rôle legacy n’intervient.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void mutate("policies", "POST", { key, scopeId }); }}>
      <input aria-label="Clé de policy" required value={key} onChange={e => setKey(e.target.value)} placeholder="Clé de policy" className="border p-2" />
      <input aria-label="Scope ID" required value={scopeId} onChange={e => setScope(e.target.value)} placeholder="UUID du scope existant" className="border p-2" />
      <button disabled={busy} className="rounded bg-blue-700 p-2 text-white">Créer une policy désactivée</button>
    </form>
    <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void mutate(`policies/${policyId}/rules`, "POST", { entitlementAId: a, entitlementBId: b }); }}>
      <select aria-label="Policy" required value={policyId} onChange={e => setPolicy(e.target.value)} className="border p-2"><option value="">Policy</option>{policies.map(p => <option key={p.id} value={p.id}>{p.key}</option>)}</select>
      <input aria-label="Entitlement A" required value={a} onChange={e => setA(e.target.value)} placeholder="UUID entitlement A" className="border p-2" />
      <input aria-label="Entitlement B" required value={b} onChange={e => setB(e.target.value)} placeholder="UUID entitlement B" className="border p-2" />
      <button disabled={busy} className="rounded bg-blue-700 p-2 text-white">Ajouter une exclusion</button>
    </form>
    <h2 className="text-xl font-semibold">Policies</h2>
    {!policies.length && <p>Aucune policy accessible.</p>}
    {policies.map(p => <article key={p.id} className="rounded border bg-white p-4">
      <h3>{p.key} — {p.status}</h3><p>Scope : {p.scopeId}</p>
      <button disabled={busy} onClick={() => void mutate(`policies/${p.id}`, "PATCH", { status: p.status === "ACTIVE" ? "DISABLED" : "ACTIVE" })} className="border p-2">{p.status === "ACTIVE" ? "Désactiver" : "Activer"}</button>
      {p.rules.map(r => <div key={r.id} className="mt-2">{r.entitlementAId} + {r.entitlementBId} — {r.enabled ? "Exclusion" : "Désactivée"}
        {r.enabled && <button disabled={busy} onClick={() => void mutate(`rules/${r.id}`, "DELETE")} className="ml-3 border p-2">Désactiver la règle</button>}</div>)}
    </article>)}
    <h2 className="text-xl font-semibold">Conflits refusés — preuves canoniques</h2>
    {!conflicts.length && <p>Aucun refus accessible.</p>}
    {conflicts.map(c => <article key={c.id} className="rounded border p-3"><time>{c.occurredAt}</time><pre className="overflow-auto">{JSON.stringify(c.metadata, null, 2)}</pre></article>)}
  </section>;
}
