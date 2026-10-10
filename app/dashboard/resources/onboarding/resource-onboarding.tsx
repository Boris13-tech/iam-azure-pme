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
    } catch { setError("La vérification n’a pas pu être effectuée."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 p-6">
    <h1 className="text-2xl font-semibold text-slate-900">Premier accès à une ressource</h1>
    <p className="text-base text-slate-600">Préparez le premier accès à la ressource interne de test. La configuration seule ne donne aucun accès.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {configuration && <>
      <h2>{configuration.capability.name}</h2>
      <p>Route : GET {configuration.capability.route}. Action : {configuration.capability.action}. Périmètre : ressource unique.</p>
      <p>Configuration : {configuration.configured ? "confirmée" : "non configurée"}.</p>
      <p>Délégation : {configuration.delegation === "BLOCKED" ? "bloquée" : configuration.delegation}. Le premier propriétaire doit être approuvé par un opérateur.</p>
      <label className="block">Identité <select value={target} onChange={event => { setTarget(event.target.value); setPlan(null); }} className="border p-2">
        <option value="">Choisir une identité</option>
        {configuration.subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name ?? subject.id}{subject.type === "HUMAN" ? "" : ` (${subject.type === "SERVICE" ? "service" : subject.type === "WORKLOAD" ? "charge de travail" : subject.type === "DEVICE" ? "appareil" : subject.type === "AI_AGENT" ? "agent IA" : subject.type})`}</option>)}
      </select></label>
      <label className="block">Durée de validité en minutes (de 1 à 60) <input type="number" min={1} max={60} value={minutes}
        onChange={event => { setMinutes(Number(event.target.value)); setPlan(null); }} className="border p-2" /></label>
      <button disabled={busy || !target || minutes < 1 || minutes > 60} onClick={() => run("plan")} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">Préparer, sans accorder d’accès</button>
    </>}
    {plan && <article className="space-y-2 rounded border p-4">
      <h2>Aperçu</h2><p>Identité : {plan.plan.targetSubjectId}. Expiration proposée : {plan.plan.validUntil}.</p>
      <p>Une ressource API, un périmètre, un droit de lecture. Aucun accès n’est accordé à cette étape.</p>
      <p>Ressource : {configuration?.capability.resourceId}. Périmètre : {configuration?.capability.scopeId}.</p>
      <p>Identifiant d’opération : {plan.operationId}. Valable jusqu’au {plan.plan.expiresAt}.</p>
      <button disabled={busy} onClick={() => run("configure")} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">Confirmer la configuration</button>
    </article>}
    <button disabled={busy} onClick={exercise} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">Tester l’accès</button>
    {evidence !== null && (() => { const result = evidence as { httpStatus?: number; evidenceId?: string };
      return <p className="rounded-md border border-slate-200 bg-white p-4">
        {result.httpStatus === 200 ? "Accès autorisé." : result.httpStatus === 403 ? "Accès refusé." : result.httpStatus === 401 ? "Vous n’êtes pas connecté." : `Réponse inattendue (code ${result.httpStatus}).`}
        {result.evidenceId && <span className="block text-sm text-slate-600">Référence dans le journal : {result.evidenceId}</span>}</p>; })()}
  </section>;
}
