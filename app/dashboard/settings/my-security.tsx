"use client";
import React, { useCallback, useEffect, useState } from "react";
import { SIGN_IN_METHOD_LABELS } from "../../../lib/ui/activity-labels";

// Security Journal v1 (R2, R3): own sessions (with self-revocation) and own passkeys (read only, S2).
type MySession = { ref: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; providerType: string; current: boolean };
type MyAuthenticator = { type: string; status: string; enrolledAt: string; lastUsedAt: string | null; hardwareBound: boolean };

const PROVIDERS: Record<string, string> = { MICROSOFT_ENTRA: "Microsoft Entra ID", LUXIA_LOCAL: "Clé d’accès" };
const STATUSES: Record<string, string> = { PENDING: "En attente", ACTIVE: "Active", SUSPENDED: "Suspendue", REVOKED: "Révoquée",
  COMPROMISED: "Compromise", EXPIRED: "Expirée", SUPERSEDED: "Remplacée" };
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "Jamais";

export function MySessions() {
  const [sessions, setSessions] = useState<MySession[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/me/sessions", { cache: "no-store" });
      if (!response.ok) throw new Error();
      setSessions(await response.json());
    } catch { setError("Impossible de charger vos sessions."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(session: MySession) {
    if (session.current && !window.confirm("Révoquer la session en cours vous déconnectera. Continuer ?")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/me/sessions/${encodeURIComponent(session.ref)}/revoke`, {
        method: "POST", headers: { "x-luxia-change-id": `self:session-revoke:${crypto.randomUUID()}` } });
      if (!response.ok) throw new Error();
      if (session.current) { window.location.assign("/login"); return; }
      await load();
    } catch { setError("La session n’a pas pu être révoquée."); }
    finally { setBusy(false); }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Mes sessions</h2>
      <p className="mt-1 text-sm text-slate-600">Appareils et navigateurs actuellement connectés à votre compte.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {sessions === null && !error && <p role="status" className="mt-3 text-sm text-slate-600">Chargement...</p>}
      {sessions?.length === 0 && <p className="mt-3 text-sm text-slate-600">Aucune session active.</p>}
      {sessions && sessions.length > 0 && (
        <table className="mt-4 w-full text-left">
          <thead className="border-b border-slate-200 text-sm font-medium text-slate-600">
            <tr><th className="py-2 pr-4">Connexion</th><th className="py-2 pr-4">Ouverte le</th><th className="py-2 pr-4">Dernière activité</th><th className="py-2 pr-4">Expire le</th><th className="py-2"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-base text-slate-800">
            {sessions.map(session => (
              <tr key={session.ref}>
                <td className="py-2 pr-4">{PROVIDERS[session.providerType] ?? session.providerType}{session.current && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-sm text-accent">Cette session</span>}</td>
                <td className="py-2 pr-4 text-sm text-slate-600">{when(session.createdAt)}</td>
                <td className="py-2 pr-4 text-sm text-slate-600">{when(session.lastSeenAt)}</td>
                <td className="py-2 pr-4 text-sm text-slate-600">{when(session.expiresAt)}</td>
                <td className="py-2 text-right">
                  <button disabled={busy} onClick={() => void revoke(session)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50">Révoquer</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function MyAuthenticators() {
  const [items, setItems] = useState<MyAuthenticator[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/me/authenticators", { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); setItems(await response.json()); })
      .catch(() => setError("Impossible de charger vos clés d’accès."));
  }, []);
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Mes clés d’accès</h2>
      <p className="mt-1 text-sm text-slate-600">Clés d’accès enregistrées pour votre compte. La révocation n’est pas encore disponible ici.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {items === null && !error && <p role="status" className="mt-3 text-sm text-slate-600">Chargement...</p>}
      {items?.length === 0 && <p className="mt-3 text-sm text-slate-600">Aucune clé d’accès enregistrée.</p>}
      {items && items.length > 0 && (
        <table className="mt-4 w-full text-left">
          <thead className="border-b border-slate-200 text-sm font-medium text-slate-600">
            <tr><th className="py-2 pr-4">Type</th><th className="py-2 pr-4">Statut</th><th className="py-2 pr-4">Ajoutée le</th><th className="py-2">Dernière utilisation</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-base text-slate-800">
            {items.map((item, index) => (
              <tr key={`${item.enrolledAt}:${index}`}>
                <td className="py-2 pr-4">{SIGN_IN_METHOD_LABELS[item.type] ?? item.type}</td>
                <td className="py-2 pr-4">{STATUSES[item.status] ?? item.status}</td>
                <td className="py-2 pr-4 text-sm text-slate-600">{when(item.enrolledAt)}</td>
                <td className="py-2 text-sm text-slate-600">{when(item.lastUsedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
