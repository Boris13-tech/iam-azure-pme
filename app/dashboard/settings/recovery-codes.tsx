"use client";
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

// First Admin / Break-glass v1, B2: the person's own recovery codes. A batch is shown once, kept only
// in this page's memory, and never readable again. The R5 notice is driven by the database (a recovery
// used the current batch), never by a flag stored in the browser, and cannot be dismissed.
type Status = { available: boolean; remaining: number; batchCreatedAt: string | null; recoveryUsedInCurrentBatch: boolean };
export const RECOVERY_SECTION_ID = "codes-de-recuperation";

const ERRORS: Record<string, string> = {
  RECENT_PASSKEY_SIGN_IN_REQUIRED: "Pour générer des codes, reconnectez-vous avec votre clé d’accès : la connexion doit dater de moins de 15 minutes.",
  RATE_LIMITED: "Trop de lots générés aujourd’hui. Réessayez demain.",
  RECOVERY_CODES_NOT_AVAILABLE: "Les codes de récupération ne sont pas disponibles pour ce compte.",
};
const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
const NOTICE = "Vous avez utilisé un code de récupération. Générez dès maintenant un nouveau lot : les codes restants de l’ancien lot restent valides jusqu’à ce moment.";

export function useRecoveryCodes() {
  const [status, setStatus] = useState<Status | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/me/recovery-codes", { cache: "no-store" });
      if (!response.ok) throw new Error();
      setStatus(await response.json());
    } catch { setError("Impossible de charger vos codes de récupération."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function mutate(path: string, kind: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "x-luxia-change-id": `self:${kind}:${crypto.randomUUID()}` } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "");
      return body;
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "";
      setError(ERRORS[code] ?? "L’opération n’a pas pu aboutir. Réessayez.");
      return null;
    } finally { setBusy(false); await load(); }
  }
  async function generate() {
    const body = await mutate("/api/me/recovery-codes", "recovery-codes-generate");
    if (body?.codes) {
      setCodes(body.codes);
      document.getElementById(RECOVERY_SECTION_ID)?.scrollIntoView({ behavior: "smooth" });
    }
  }
  async function revokeAll() {
    if (!window.confirm("Révoquer tous vos codes de récupération ? Ils ne pourront plus jamais être utilisés.")) return;
    setCodes(null);
    await mutate("/api/me/recovery-codes/revoke", "recovery-codes-revoke");
  }
  return { status, codes, error, busy, generate, revokeAll, saved: () => setCodes(null) };
}
type RecoveryCodesState = ReturnType<typeof useRecoveryCodes>;

function NoticeBox({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2 text-sm"><AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />{NOTICE}</p>
      {children}
    </div>
  );
}
const PRIMARY = "flex-shrink-0 rounded-md bg-[#1f5fbf] px-4 py-2 text-sm font-medium text-white hover:bg-[#194e9e] disabled:opacity-50";

/** Authentication page: the notice generates the new batch directly. */
export function RecoveryNotice({ recovery }: { recovery: RecoveryCodesState }) {
  if (!recovery.status?.recoveryUsedInCurrentBatch) return null;
  return <NoticeBox><button type="button" disabled={recovery.busy} onClick={() => void recovery.generate()} className={PRIMARY}>Générer un nouveau lot</button></NoticeBox>;
}

/** Overview: same notice; the button opens the Authentication page, where the batch is generated. */
export function RecoveryNoticeLink() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    fetch("/api/me/recovery-codes", { cache: "no-store" })
      .then(async response => { if (response.ok) setShow(Boolean((await response.json()).recoveryUsedInCurrentBatch)); })
      .catch(() => undefined);
  }, []);
  if (!show) return null;
  return <NoticeBox><Link href={`/dashboard/settings#${RECOVERY_SECTION_ID}`} className={PRIMARY}>Générer un nouveau lot</Link></NoticeBox>;
}

export function RecoveryCodes({ recovery }: { recovery: RecoveryCodesState }) {
  const { status, codes, error, busy } = recovery;
  const [copied, setCopied] = useState(false);
  const text = codes ? `LUXIA Identity - codes de récupération\n\n${codes.join("\n")}\n\nChaque code ne sert qu’une fois.\n` : "";
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "luxia-codes-de-recuperation.txt"; link.click();
    URL.revokeObjectURL(url);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  }
  if (status && !status.available) return null; // Microsoft-only accounts: Microsoft handles recovery.
  return (
    <section id={RECOVERY_SECTION_ID} className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Codes de récupération</h2>
      <p className="mt-1 text-sm text-slate-600">
        Si vous perdez votre clé d’accès, un code de récupération vous permet d’en ajouter une nouvelle. Chaque code ne sert
        qu’une fois. Générer un nouveau lot révoque les codes inutilisés du lot précédent.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {status === null && !error && <p role="status" className="mt-3 text-sm text-slate-600">Chargement...</p>}
      {status && !codes && (
        <p className="mt-3 text-base text-slate-800">
          {status.remaining === 0 ? "Aucun code de récupération utilisable." : `${status.remaining} code${status.remaining > 1 ? "s" : ""} restant${status.remaining > 1 ? "s" : ""}.`}
          {status.batchCreatedAt && <span className="ml-2 text-sm text-slate-600">Lot généré le {when(status.batchCreatedAt)}.</span>}
        </p>
      )}
      {codes && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium text-slate-900">Enregistrez ces codes maintenant : ils ne seront plus jamais affichés.</p>
          <ol className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 bg-slate-50 p-4 font-mono text-base text-slate-900 sm:grid-cols-2">
            {codes.map(code => <li key={code}>{code}</li>)}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copy()} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50">{copied ? "Copié" : "Copier"}</button>
            <button type="button" onClick={download} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50">Télécharger (.txt)</button>
            <button type="button" onClick={recovery.saved} className="rounded-md bg-[#1f5fbf] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#194e9e]">J’ai enregistré mes codes</button>
          </div>
        </div>
      )}
      {status && !codes && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void recovery.generate()} className="rounded-md bg-[#1f5fbf] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#194e9e] disabled:opacity-50">
            {status.batchCreatedAt ? "Générer un nouveau lot de 10 codes" : "Générer 10 codes"}
          </button>
          {status.remaining > 0 && (
            <button type="button" disabled={busy} onClick={() => void recovery.revokeAll()} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50">
              Révoquer tous mes codes
            </button>
          )}
        </div>
      )}
    </section>
  );
}
