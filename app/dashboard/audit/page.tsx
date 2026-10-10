"use client";
import React, { useCallback, useEffect, useState } from "react";
import { OPERATION_LABELS, RESULT_LABELS, operationLabel } from "../../../lib/ui/activity-labels";

// Canonical audit journal (CanonicalAdminAuditEvent) through GET /api/canonical/audit:
// tenant-scoped (RLS), gated by audit.read, and every consultation is itself audited (AUDIT.READ).
type AuditEvent = { id: string; operation: string; result: string; occurredAt: string;
  actor: { name: string } | null; target: { name: string } | null };
const PAGE = 50;

export default function AuditJournalPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [operation, setOperation] = useState("");
  const [showReads, setShowReads] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (skip: number) => {
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ take: String(PAGE), skip: String(skip), excludeReads: String(!showReads) });
      if (operation) params.set("operation", operation);
      const response = await fetch(`/api/canonical/audit?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 ? "Vous n’avez pas accès au journal d’audit." : "Impossible de charger le journal d’audit.");
      const rows: AuditEvent[] = await response.json();
      setEvents(previous => skip === 0 ? rows : [...previous, ...rows]);
      setHasMore(rows.length === PAGE);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de charger le journal d’audit."); }
    finally { setBusy(false); }
  }, [operation, showReads]);

  useEffect(() => { void load(0); }, [load]);

  const choices = Object.entries(OPERATION_LABELS).filter(([code]) => showReads || !code.endsWith(".READ"))
    .sort(([, a], [, b]) => a.localeCompare(b, "fr"));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Journal d’audit</h1>
        <p className="mt-1 text-base text-slate-600">Toutes les actions enregistrées dans votre environnement, de la plus récente à la plus ancienne.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">Action
          <select value={operation} onChange={event => setOperation(event.target.value)} className="min-w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900">
            <option value="">Toutes les actions</option>
            {choices.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={showReads} onChange={event => { setShowReads(event.target.checked); if (!event.target.checked && operation.endsWith(".READ")) setOperation(""); }} className="h-4 w-4" />
          Afficher les consultations
        </label>
      </div>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left">
          <thead className="border-b border-slate-200 bg-slate-50 text-sm font-medium text-slate-600">
            <tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Résultat</th><th className="px-4 py-3">Auteur</th><th className="px-4 py-3">Cible</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-base text-slate-800">
            {events.map(event => (
              <tr key={event.id}>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-600">{new Date(event.occurredAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" })}</td>
                <td className="px-4 py-3" title={event.operation}>{operationLabel(event.operation) ?? "Autre action"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${event.result === "SUCCESS" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
                    {RESULT_LABELS[event.result] ?? event.result}
                  </span>
                </td>
                <td className="px-4 py-3">{event.actor?.name ?? "Système"}</td>
                <td className="px-4 py-3 text-slate-600">{event.target?.name ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!busy && !error && events.length === 0 && <p className="p-6 text-center text-slate-600">Aucun événement.</p>}
        {busy && <p role="status" className="p-4 text-center text-sm text-slate-600">Chargement...</p>}
      </div>

      {hasMore && !busy && (
        <button onClick={() => void load(events.length)} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
          Afficher plus
        </button>
      )}
    </div>
  );
}
