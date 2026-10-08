"use client";
import { useEffect, useState } from "react";

type Configuration = { capability: { name: string; route: string; resourceId: string; scopeId: string; action: string };
  subjects: { id: string; name: string | null; type: string }[]; configured: boolean; delegation: string; reasonCode: string };
type Plan = { operationId: string; plan: { targetSubjectId: string; validUntil: string; expiresAt: string } };
const endpoint = "/api/canonical/resource-onboarding";

export default function Onboarding() {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [target, setTarget] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [evidence, setEvidence] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch(endpoint, { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Configuration refusée ou indisponible.");
      setConfiguration(await response.json());
    }).catch(cause => setError(cause.message));
  }, []);
  async function run(command: "plan" | "configure") {
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(command === "plan" ? { command, targetSubjectId: target, validUntil: new Date(Date.now() + minutes * 60_000).toISOString() }
          : { command, operationId: plan?.operationId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Opération refusée.");
      if (command === "plan") setPlan(result); else {
        const preview = await fetch(`${endpoint}?operationId=${plan?.operationId}`, { cache: "no-store" });
        if (!preview.ok) throw new Error("Configuration appliquée, mais aperçu indisponible. Aucun accès accordé.");
        const resultPreview = await preview.json();
        setEvidence(resultPreview);
        setConfiguration(previous => previous ? { ...previous, configured: resultPreview.configured === true } : previous);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Opération indisponible."); }
    finally { setBusy(false); }
  }
  async function exercise() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/resources/protected-resource-demo", { cache: "no-store" });
      setEvidence({ httpStatus: response.status, ...(await response.json()) });
    } catch { setError("Vérification serveur indisponible."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 p-6">
    <h1 className="text-2xl font-bold">Premier accès à une ressource LUXIA</h1>
    <p>Cette tranche protège une route interne dédiée, pas le dashboard. Configurer ne donne aucun accès.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {configuration && <>
      <h2>{configuration.capability.name}</h2>
      <p>GET {configuration.capability.route} · action : {configuration.capability.action} · scope : RESOURCE</p>
      <p>Binding canonique : {configuration.configured ? "confirmé par le serveur" : "non configuré"}.</p>
      <p>Délégation : {configuration.delegation} — approbation opérateur du premier propriétaire requise.</p>
      <label className="block">Subject existant <select value={target} onChange={event => { setTarget(event.target.value); setPlan(null); }} className="border p-2">
        <option value="">Sélectionner une identité réelle</option>
        {configuration.subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name ?? subject.id} · {subject.type}</option>)}
      </select></label>
      <label className="block">Validité proposée (minutes, 1–60) <input type="number" min={1} max={60} value={minutes}
        onChange={event => { setMinutes(Number(event.target.value)); setPlan(null); }} className="border p-2" /></label>
      <button disabled={busy || !target || minutes < 1 || minutes > 60} onClick={() => run("plan")} className="rounded border p-2">Préparer le plan sans grant</button>
    </>}
    {plan && <article className="space-y-2 rounded border p-4">
      <h2>Aperçu exact</h2><p>Subject : {plan.plan.targetSubjectId} · expiration proposée : {plan.plan.validUntil}</p>
      <p>1 Resource API, 1 scope RESOURCE, 1 Entitlement resource.read. Assignments créés : 0.</p>
      <p>Resource : {configuration?.capability.resourceId} · Scope : {configuration?.capability.scopeId}</p>
      <p>Operation ID serveur : {plan.operationId} · plan valable jusqu’au {plan.plan.expiresAt}</p>
      <button disabled={busy} onClick={() => run("configure")} className="rounded border p-2">Confirmer uniquement la configuration</button>
    </article>}
    <button disabled={busy} onClick={exercise} className="rounded border p-2">Vérifier l’accès à la route serveur</button>
    {evidence !== null && <pre className="overflow-x-auto rounded border p-4">{JSON.stringify(evidence, null, 2)}</pre>}
  </section>;
}
