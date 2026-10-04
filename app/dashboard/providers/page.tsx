"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
type Provider = { id: string; name: string; providerType: string; enabled: boolean; operationalStatus: string; lastSyncAt: string | null };
export default function ProvidersPage() {
  const [rows, setRows] = useState<Provider[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [externalScopeId, setExternalScopeId] = useState("");
  const [providerType, setProviderType] = useState("MICROSOFT_ENTRA");
  const load = useCallback(async () => {
    const response = await fetch("/api/canonical/provider-management", { cache: "no-store" });
    if (!response.ok) throw new Error("Impossible de charger les fournisseurs autorisés.");
    setRows(await response.json());
  }, []);
  useEffect(() => { load().catch(error => setMessage(error.message)); }, [load]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/canonical/providers", { method: "POST",
        headers: { "Content-Type": "application/json", "x-luxia-change-id": crypto.randomUUID() },
        body: JSON.stringify({ name, externalScopeId, providerType }) });
      if (!response.ok) throw new Error("Création refusée : vérifiez vos droits et l’unicité du fournisseur.");
      setName(""); setExternalScopeId(""); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Opération indisponible."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <h2 className="text-2xl font-bold">Fournisseurs d’identité</h2>
    <p>Connexions de cette entreprise et de ce tenant. Les identités LUXIA conservent leurs identifiants canoniques.</p>
    <form onSubmit={create} className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
      <label>Fournisseur<select className="block w-full rounded border p-2" value={providerType} onChange={e => setProviderType(e.target.value)}>
        <option value="MICROSOFT_ENTRA">Microsoft Entra</option><option value="GOOGLE_WORKSPACE">Google Workspace</option><option value="OIDC_GENERIC">OIDC générique</option>
      </select></label>
      <label>Nom<input required maxLength={200} className="block w-full rounded border p-2" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Directory ID, Customer ID ou issuer OIDC<input required maxLength={512} className="block w-full rounded border p-2" value={externalScopeId} onChange={e => setExternalScopeId(e.target.value)} /></label>
      <button disabled={busy} className="rounded bg-blue-700 p-2 text-white disabled:opacity-50">Créer avec les opérations de gestion désactivées</button>
    </form>
    {message && <p role="alert">{message}</p>}
    <div className="space-y-3">{rows.map(row => <Link key={row.id} href={`/dashboard/providers/${row.id}`} className="block rounded-xl border bg-white p-5">
      <strong>{row.name}</strong><p>{row.providerType} · {row.operationalStatus}</p>
      <p>Opérations de gestion {row.enabled ? "activées" : "désactivées"}</p>
      <small>Dernière opération de découverte : {row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString("fr-FR") : "Aucune"}</small>
    </Link>)}</div>
    {!rows.length && <p>Aucun fournisseur visible dans ce tenant.</p>}
  </div>;
}
