"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
type Detail = {
  expectedSecretReference: string;
  provider: { id: string; name: string; providerType: string; externalScopeId: string; enabled: boolean;
    operationalStatus: string; mappingVersion: number; attributeMapping: Record<string, string>; lastErrorCode: string | null };
  history: { id: string; operation: string; status: string; observed: number; conflicts: number; startedAt: string; safeErrorCode: string | null }[];
  collisions: { id: string; externalObjectId: string; reasonCode: string; resolvedAt: string | null }[];
};
export default function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState(""); const [secretReference, setSecretReference] = useState("");
  const [displayName, setDisplayName] = useState("displayName");
  const [principalName, setPrincipalName] = useState("userPrincipalName");
  const load = useCallback(async () => {
    const response = await fetch(`/api/canonical/provider-management/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Fournisseur indisponible dans ce tenant.");
    const result: Detail = await response.json(); setDetail(result);
    setDisplayName(result.provider.attributeMapping.displayName ?? (result.provider.providerType === "GOOGLE_WORKSPACE" ? "name.fullName" : "displayName"));
    setPrincipalName(result.provider.attributeMapping.principalName ?? (result.provider.providerType === "GOOGLE_WORKSPACE" ? "primaryEmail" : "userPrincipalName"));
  }, [id]);
  useEffect(() => { load().catch(error => setMessage(error.message)); }, [load]);
  async function command(path: string, method: string, body: unknown) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/canonical/provider-management/${encodeURIComponent(id)}${path}`, {
        method, headers: { "Content-Type": "application/json", "x-luxia-change-id": crypto.randomUUID() }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Opération refusée.");
      setMessage(result.safeErrorCode ?? "Opération enregistrée."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Opération indisponible."); }
    finally { setBusy(false); }
  }
  if (!detail) return <p role="status">{message || "Chargement du fournisseur…"}</p>;
  const p = detail.provider;
  const supported = ["MICROSOFT_ENTRA", "GOOGLE_WORKSPACE", "OIDC_GENERIC"].includes(p.providerType);
  return <div className="space-y-5">
    <h2 className="text-2xl font-bold">{p.name}</h2><p>{p.providerType} · {p.operationalStatus}</p>
    <p>Scope externe : {p.externalScopeId}</p>
    {message && <p role="alert" className="rounded border p-3">{message}</p>}
    {supported && <section className="space-y-3 rounded-xl bg-white p-5">
      <h3 className="font-bold">Configuration et mapping — version {p.mappingVersion}</h3>
      {p.providerType === "MICROSOFT_ENTRA" && <label className="block">Client ID Graph<input className="ml-3 rounded border p-2" value={clientId} onChange={e => setClientId(e.target.value)} /></label>}
      {p.providerType !== "OIDC_GENERIC" && <><p className="break-all">Référence réservée à cette connexion : <code>{detail.expectedSecretReference}</code></p>
        <label className="block">Utiliser cette référence au secret<input type="checkbox" className="ml-3" checked={!!secretReference} onChange={e => setSecretReference(e.target.checked ? detail.expectedSecretReference : "")} /></label></>}
      <p>Les valeurs de secrets sont déposées dans le coffre d’exécution par l’opérateur. Ne saisissez aucun token ou secret ici.</p>
      {p.providerType !== "OIDC_GENERIC" && <><label className="block">Nom affiché<select value={displayName} onChange={e => setDisplayName(e.target.value)}><option>displayName</option><option>name.fullName</option></select></label>
        <label className="block">Identifiant affiché<select value={principalName} onChange={e => setPrincipalName(e.target.value)}><option>userPrincipalName</option><option>primaryEmail</option></select></label></>}
      <button disabled={busy} className="rounded bg-blue-700 p-2 text-white" onClick={() => command("", "PATCH", {
        expectedMappingVersion: p.mappingVersion,
        configuration: p.providerType === "MICROSOFT_ENTRA" ? (clientId ? { clientId } : undefined) :
          p.providerType === "GOOGLE_WORKSPACE" ? { customerId: p.externalScopeId } : { issuer: p.externalScopeId },
        ...(secretReference ? { credentialSecretRef: secretReference } : {}),
        attributeMapping: p.providerType === "OIDC_GENERIC" ? {} : { displayName, principalName },
      })}>Enregistrer la configuration</button>
      <button disabled={busy} className="ml-3 rounded border p-2" onClick={() => command("", "PATCH", { enabled: !p.enabled, expectedMappingVersion: p.mappingVersion })}>{p.enabled ? "Désactiver les opérations" : "Activer les opérations"}</button>
      <button disabled={busy || !p.enabled} className="ml-3 rounded border p-2" onClick={() => command("/operations", "POST", { operation: "CONNECTION_TEST" })}>Tester la connexion</button>
      {p.providerType !== "OIDC_GENERIC" && <button disabled={busy || !p.enabled} className="ml-3 rounded border p-2" onClick={() => command("/operations", "POST", { operation: "SYNC_DRY_RUN" })}>Découverte / sync dry-run</button>}
      <p>Le dry-run examine les comptes externes et les collisions. La création de Subjects, la fusion et le provisioning exigent un rapprochement validé.</p>
      {p.providerType === "OIDC_GENERIC" && <p>OIDC : test des métadonnées uniquement. La découverte d’un annuaire requiert un connecteur dédié ou SCIM.</p>}
    </section>}
    {!supported && <p>Contrat préparé ; opérations d’exploitation indisponibles dans cette tranche.</p>}
    <section><h3 className="font-bold">Historique des opérations</h3>{detail.history.map(run => <div className="my-2 rounded border bg-white p-3" key={run.id}>{run.operation} · {run.status} · {run.observed} comptes observés · {run.conflicts} collisions · {run.safeErrorCode}<small className="block">{new Date(run.startedAt).toLocaleString("fr-FR")}</small></div>)}</section>
    <section><h3 className="font-bold">Collisions en quarantaine</h3>{detail.collisions.map(c => <div key={c.id}>{c.externalObjectId} · {c.reasonCode} · {c.resolvedAt ? "Projection rejetée" : "Revue manuelle requise"}
      {!c.resolvedAt && <button disabled={busy} className="ml-3 rounded border p-2" onClick={() => command(`/collisions/${encodeURIComponent(c.id)}`, "POST", { disposition: "REJECT_PROJECTION" })}>Rejeter cette projection</button>}</div>)}
      <p>Corrigez la source externe puis rejouez la découverte. Aucun rapprochement par nom ou email n’est exécuté.</p></section>
  </div>;
}
