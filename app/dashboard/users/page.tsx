"use client";

import { useCallback, useEffect, useState } from "react";
import { PauseCircle, PlayCircle, ShieldCheck, UserPlus, UserX } from "lucide-react";

type Subject = { id: string; name: string; type: string; lifecycleState: string; lifecycleVersion: number };

const TYPE_LABELS: Record<string, string> = { HUMAN: "Personne", WORKLOAD: "Charge de travail", SERVICE: "Service", DEVICE: "Appareil", AI_AGENT: "Agent IA" };
const STATE_LABELS: Record<string, string> = { PROVISIONING: "En création", ACTIVE: "Active", SUSPENDED: "Suspendue", DISABLED: "Désactivée",
  RECOVERY_REQUIRED: "En récupération", RETIRED: "Partie" };

export default function IdentitiesPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [name, setName] = useState("");
  const [currentSubjectId, setCurrentSubjectId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [response, contextResponse] = await Promise.all([
      fetch("/api/canonical/subjects", { cache: "no-store" }),
      fetch("/api/platform/context", { cache: "no-store" }),
    ]);
    if (!response.ok || !contextResponse.ok) throw new Error("SUBJECT_READ_FAILED");
    const [rows, context] = await Promise.all([response.json(), contextResponse.json()]);
    setSubjects(rows); setCurrentSubjectId(context.subject.id);
  }, []);
  useEffect(() => { load().catch(() => setMessage("Impossible de charger les identités.")); }, [load]);

  async function createJoiner(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/canonical/subjects", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ name, type: "HUMAN", lifecycleState: "PROVISIONING" }),
    });
    setBusy(false);
    if (!response.ok) return setMessage("Création refusée. Vérifiez vos droits.");
    setName(""); setMessage("Identité créée. Elle doit être activée."); await load();
  }

  async function transition(subject: Subject, lifecycleState: string) {
    setBusy(true); setMessage("");
    const response = await fetch(`/api/canonical/subjects/${subject.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ lifecycleState }),
    });
    setBusy(false);
    if (!response.ok) return setMessage("Changement refusé. Vérifiez l’état de l’identité et vos droits.");
    setMessage(`${subject.name} : statut changé en « ${STATE_LABELS[lifecycleState] ?? lifecycleState} ».`); await load();
  }

  return <div className="space-y-6">
    <header className="border-b border-slate-200 pb-4">
      <h1 className="text-2xl font-semibold text-slate-900">Identités</h1>
      <p className="mt-1 text-base text-slate-600">Arrivées, changements de statut et départs.</p>
    </header>
    <form onSubmit={createJoiner} className="flex flex-col gap-3 rounded-2xl border border-blue-100 bg-white p-5 shadow-sm sm:flex-row sm:items-end">
      <div className="flex-1"><label className="mb-1 block text-sm font-semibold text-slate-700">Nom de la nouvelle personne</label><input value={name} onChange={e => setName(e.target.value)} required maxLength={200} className="w-full rounded-xl border border-slate-300 px-4 py-3" placeholder="Nom complet" /></div>
      <button disabled={busy || !name.trim()} className="flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong disabled:opacity-50"><UserPlus className="h-5 w-5" /> Ajouter une personne</button>
    </form>
    {message && <p className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">{message}</p>}
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full"><thead className="bg-slate-50 text-left text-sm font-medium text-slate-600"><tr><th className="px-5 py-4">Identité</th><th className="px-5 py-4">Type</th><th className="px-5 py-4">État</th><th className="px-5 py-4">Actions</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{subjects.map(subject => <tr key={subject.id}>
          <td className="px-5 py-4"><div className="font-semibold text-slate-900">{subject.name}</div></td>
          <td className="px-5 py-4 text-sm text-slate-600">{TYPE_LABELS[subject.type] ?? subject.type}</td>
          <td className="px-5 py-4"><span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">{STATE_LABELS[subject.lifecycleState] ?? subject.lifecycleState}</span></td>
          <td className="px-5 py-4"><div className="flex flex-wrap gap-2">
            {subject.lifecycleState !== "ACTIVE" && subject.lifecycleState !== "RETIRED" && <button type="button" disabled={busy} onClick={() => transition(subject, "ACTIVE")} className="rounded-md border px-3 py-1.5 text-sm font-medium text-emerald-700"><PlayCircle className="mr-1 inline h-4 w-4" />Activer</button>}
            {subject.id !== currentSubjectId && subject.lifecycleState === "ACTIVE" && <button type="button" disabled={busy} onClick={() => transition(subject, "SUSPENDED")} className="rounded-md border px-3 py-1.5 text-sm font-medium text-amber-700"><PauseCircle className="mr-1 inline h-4 w-4" />Suspendre</button>}
            {subject.id !== currentSubjectId && subject.lifecycleState !== "RETIRED" && <button type="button" disabled={busy} onClick={() => transition(subject, "RETIRED")} className="rounded-md border px-3 py-1.5 text-sm font-medium text-red-700"><UserX className="mr-1 inline h-4 w-4" />Départ définitif</button>}
          </div></td>
        </tr>)}</tbody>
      </table>
      {subjects.length === 0 && <div className="p-10 text-center text-slate-500"><ShieldCheck className="mx-auto mb-3 h-8 w-8" />Aucune identité.</div>}
    </div>
  </div>;
}
