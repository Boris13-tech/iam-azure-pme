"use client";
import React, { useCallback, useEffect, useState } from "react";
import { ASSURANCE_LABELS, REFUSAL_LABELS, RESULT_LABELS, SIGN_IN_METHOD_LABELS, operationLabel } from "../../../lib/ui/activity-labels";

// Security journal (Security Journal v1): GET /api/canonical/security-journal merges administrative
// events and sign-ins. Tenant-scoped (RLS), gated by audit.read, each consultation audited.
type Entry = { id: string; kind: "SIGN_IN" | "ADMIN"; occurredAt: string; action: string; result: string;
  actorName: string | null; targetName: string | null; method?: string; assurance?: string; reasonCode?: string };
type Page = { entries: Entry[]; nextCursor: string | null };
const KINDS = [["all", "Tous les événements"], ["sign-in", "Connexions"], ["admin", "Administration"]] as const;

function eventLabel(entry: Entry): string {
  if (entry.kind === "SIGN_IN") return entry.result === "SUCCESS" ? "Connexion" : "Connexion refusée";
  return operationLabel(entry.action) ?? "Autre action";
}
function detail(entry: Entry): string {
  if (entry.kind !== "SIGN_IN") return "";
  const method = entry.method ? SIGN_IN_METHOD_LABELS[entry.method] ?? entry.method : "";
  if (entry.result !== "SUCCESS") return [method, entry.reasonCode ? REFUSAL_LABELS[entry.reasonCode] ?? entry.reasonCode : ""].filter(Boolean).join(", ");
  return [method, entry.assurance ? ASSURANCE_LABELS[entry.assurance] ?? "" : ""].filter(Boolean).join(", ");
}

export default function SecurityJournalPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("all");
  const [showReads, setShowReads] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (from: string | null) => {
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ limit: "50", kind, includeReads: String(showReads) });
      if (from) params.set("cursor", from);
      const response = await fetch(`/api/canonical/security-journal?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 ? "Vous n’avez pas accès au journal d’audit." : "Impossible de charger le journal d’audit.");
      const page: Page = await response.json();
      setEntries(previous => from ? [...previous, ...page.entries] : page.entries);
      setCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de charger le journal d’audit."); }
    finally { setBusy(false); }
  }, [kind, showReads]);

  useEffect(() => { void load(null); }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Journal d’audit</h1>
        <p className="mt-1 text-base text-slate-600">Connexions et actions enregistrées dans votre environnement, de la plus récente à la plus ancienne.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">Type
          <select value={kind} onChange={event => setKind(event.target.value as typeof kind)} className="min-w-56 rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900">
            {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={showReads} onChange={event => setShowReads(event.target.checked)} className="h-4 w-4" />
          Afficher les consultations
        </label>
      </div>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left">
          <thead className="border-b border-slate-200 bg-slate-50 text-sm font-medium text-slate-600">
            <tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Événement</th><th className="px-4 py-3">Résultat</th><th className="px-4 py-3">Détail</th><th className="px-4 py-3">Auteur</th><th className="px-4 py-3">Cible</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-base text-slate-800">
            {entries.map(entry => (
              <tr key={`${entry.kind}:${entry.id}`}>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-600">{new Date(entry.occurredAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" })}</td>
                <td className="px-4 py-3" title={entry.kind === "ADMIN" ? entry.action : undefined}>{eventLabel(entry)}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${entry.result === "SUCCESS" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
                    {RESULT_LABELS[entry.result] ?? entry.result}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-slate-600">{detail(entry)}</td>
                <td className="px-4 py-3">{entry.actorName ?? "Système"}</td>
                <td className="px-4 py-3 text-slate-600">{entry.targetName && entry.targetName !== entry.actorName ? entry.targetName : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!busy && !error && entries.length === 0 && <p className="p-6 text-center text-slate-600">Aucun événement.</p>}
        {busy && <p role="status" className="p-4 text-center text-sm text-slate-600">Chargement...</p>}
      </div>

      {cursor && !busy && (
        <button onClick={() => void load(cursor)} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
          Afficher plus
        </button>
      )}
    </div>
  );
}
