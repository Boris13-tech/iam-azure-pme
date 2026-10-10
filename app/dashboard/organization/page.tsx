"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Globe, UserPlus } from "lucide-react";

// Customer Self-Onboarding v1: domains (DNS TXT) and team invitations (link to copy, no email).
type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "restricted" } | { state: "unavailable" };
const changeId = (operation: string) => `ui:${operation}:${crypto.randomUUID()}`;
const date = (value: string | null) => value ? new Date(value).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "";

async function load<T>(url: string, key: string): Promise<Load<T>> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 403) return { state: "restricted" };
    if (!response.ok) return { state: "unavailable" };
    return { state: "ok", data: (await response.json())[key] as T };
  } catch { return { state: "unavailable" }; }
}
async function post(url: string, operation: string, body?: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-luxia-change-id": changeId(operation) }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}

const ERRORS: Record<string, string> = {
  INVALID_DOMAIN: "Ce nom de domaine n’est pas valide.",
  DOMAIN_ALREADY_VERIFIED: "Ce domaine est déjà vérifié pour votre organisation.",
  DOMAIN_RECORD_NOT_FOUND: "L’enregistrement TXT n’a pas été trouvé. La propagation DNS peut prendre du temps : réessayez plus tard.",
  DOMAIN_CHALLENGE_EXPIRED: "La valeur de vérification a expiré. Ajoutez de nouveau le domaine pour en obtenir une nouvelle.",
  DOMAIN_CHALLENGE_REQUIRED: "Ajoutez de nouveau le domaine pour obtenir une nouvelle valeur de vérification.",
  DOMAIN_VERIFIED_ELSEWHERE: "Ce domaine est déjà vérifié par une autre organisation.",
  DNS_UNAVAILABLE: "Le service DNS n’a pas répondu. Réessayez dans quelques minutes.",
  RATE_LIMITED: "Trop de tentatives. Réessayez plus tard.",
  FORBIDDEN: "Vous n’avez pas le droit d’effectuer cette action.",
  INVALID_REQUEST_BODY: "Vérifiez les champs.",
  INVITATION_NOT_OPEN: "Cette invitation a déjà été acceptée ou révoquée.",
};
const errorText = (code: unknown) => (typeof code === "string" && ERRORS[code]) || "L’action n’a pas pu être effectuée. Réessayez.";

type Domain = { id: string; domain: string; status: string; recordName: string; challengeExpiresAt: string; verifiedAt: string | null; lastCheckedAt: string | null };
const DOMAIN_STATUS: Record<string, string> = { PENDING: "En attente de vérification", VERIFIED: "Vérifié", EXPIRED: "Valeur expirée", LOST: "Vérification perdue" };

function Domains() {
  const [list, setList] = useState<Load<Domain[]>>({ state: "loading" });
  const [domain, setDomain] = useState("");
  const [record, setRecord] = useState<{ name: string; value: string } | null>(null);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => setList(await load<Domain[]>("/api/onboarding/domains", "domains")), []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function add(event: React.FormEvent) {
    event.preventDefault(); setMessage(""); setRecord(null);
    const result = await post("/api/onboarding/domains", "domain-add", { domain });
    if (!result.ok) { setMessage(errorText(result.json.error)); return; }
    setRecord({ name: result.json.recordName, value: result.json.recordValue }); setDomain(""); void refresh();
  }
  async function check(item: Domain) {
    setMessage("");
    const result = await post(`/api/onboarding/domains/${encodeURIComponent(item.id)}/check`, "domain-check");
    if (!result.ok) setMessage(errorText(result.json.error));
    else if (result.json.status === "LOST") setMessage(`${item.domain} : l’enregistrement TXT n’existe plus. Le domaine n’est plus vérifié.`);
    else setMessage(`${item.domain} : vérifié.`);
    void refresh();
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><Globe className="h-5 w-5 text-accent" aria-hidden /> Domaines</h2>
      <p className="mt-1 text-sm text-slate-600">Un domaine est vérifié uniquement par un enregistrement DNS TXT. Un domaine ne peut être vérifié que par une seule organisation.</p>
      {list.state === "restricted" ? <p className="mt-4 text-sm text-slate-600">Accès restreint.</p> : <>
        <form onSubmit={add} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="entreprise.fr" autoCapitalize="none" spellCheck={false}
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base" aria-label="Nom de domaine" />
          <button type="submit" disabled={!domain} className="rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong disabled:opacity-50">Ajouter le domaine</button>
        </form>
        {record && <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
          <p className="font-medium">Ajoutez cet enregistrement dans la zone DNS du domaine, puis cliquez sur Vérifier.</p>
          <p className="mt-2">Type : <span className="font-mono">TXT</span></p>
          <p>Nom : <span className="font-mono break-all">{record.name}</span></p>
          <p>Valeur : <span className="font-mono break-all">{record.value}</span></p>
          <p className="mt-2 text-slate-600">Cette valeur n’est affichée qu’une fois et expire dans 7 jours. Conservez l’enregistrement après la vérification : il sert aux contrôles ultérieurs.</p>
        </div>}
        {message && <p className="mt-3 text-sm text-slate-700" role="status">{message}</p>}
        {list.state === "unavailable" && <p className="mt-4 text-sm text-red-700">La liste des domaines est indisponible.</p>}
        {list.state === "ok" && (list.data.length === 0 ? <p className="mt-4 text-sm text-slate-600">Aucun domaine.</p> :
          <ul className="mt-4 divide-y divide-slate-100">
            {list.data.map(item => <li key={item.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-slate-900">{item.domain}</p>
                <p className="text-sm text-slate-600">{DOMAIN_STATUS[item.status] ?? item.status}
                  {item.status === "VERIFIED" && item.verifiedAt ? `, depuis le ${date(item.verifiedAt)}` : ""}
                  {item.status === "PENDING" ? `, valeur valable jusqu’au ${date(item.challengeExpiresAt)}` : ""}</p>
              </div>
              {(item.status === "PENDING" || item.status === "VERIFIED") &&
                <button onClick={() => check(item)} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">{item.status === "PENDING" ? "Vérifier" : "Contrôler de nouveau"}</button>}
            </li>)}
          </ul>)}
      </>}
    </section>
  );
}

type Invitation = { id: string; name: string; role: "MEMBER" | "ADMIN"; status: string; createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null };
const INVITATION_STATUS: Record<string, string> = { PENDING: "Invitation créée, en attente d’acceptation", ACCEPTED: "Acceptée", REVOKED: "Révoquée", EXPIRED: "Expirée" };
const ROLE: Record<string, string> = { MEMBER: "Membre", ADMIN: "Administrateur" };

function Invitations() {
  const [list, setList] = useState<Load<Invitation[]>>({ state: "loading" });
  const [name, setName] = useState("");
  const [role, setRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => setList(await load<Invitation[]>("/api/onboarding/invitations", "invitations")), []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setMessage(""); setLink(""); setCopied(false);
    const result = await post("/api/onboarding/invitations", "invitation-create", { name, role });
    if (!result.ok) { setMessage(errorText(result.json.error)); return; }
    setLink(result.json.link); setName(""); void refresh();
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setMessage("La copie a échoué. Sélectionnez le lien et copiez-le."); }
  }
  async function revoke(item: Invitation) {
    setMessage("");
    const result = await post(`/api/onboarding/invitations/${encodeURIComponent(item.id)}/revoke`, "invitation-revoke");
    if (!result.ok) setMessage(errorText(result.json.error));
    void refresh();
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><UserPlus className="h-5 w-5 text-accent" aria-hidden /> Invitations</h2>
      <p className="mt-1 text-sm text-slate-600">LUXIA n’envoie pas d’e-mail : copiez le lien et transmettez-le vous-même à la personne. Le lien fonctionne une fois et expire au bout de 7 jours.</p>
      {list.state === "restricted" ? <p className="mt-4 text-sm text-slate-600">Accès restreint.</p> : <>
        <form onSubmit={create} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Nom de la personne" maxLength={120}
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base" aria-label="Nom de la personne" />
          <select value={role} onChange={e => setRole(e.target.value as "MEMBER" | "ADMIN")} className="rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base" aria-label="Rôle">
            <option value="MEMBER">Membre</option>
            <option value="ADMIN">Administrateur</option>
          </select>
          <button type="submit" disabled={name.trim().length < 2} className="rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong disabled:opacity-50">Créer l’invitation</button>
        </form>
        {link && <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
          <p className="font-medium">Invitation créée, en attente d’acceptation.</p>
          <p className="mt-2 font-mono break-all">{link}</p>
          <button onClick={copy} className="mt-3 flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
            <Copy className="h-4 w-4" aria-hidden /> {copied ? "Lien copié" : "Copier le lien d’invitation"}
          </button>
          <p className="mt-2 text-slate-600">Ce lien n’est affiché qu’une fois.</p>
        </div>}
        {message && <p className="mt-3 text-sm text-slate-700" role="status">{message}</p>}
        {list.state === "unavailable" && <p className="mt-4 text-sm text-red-700">La liste des invitations est indisponible.</p>}
        {list.state === "ok" && (list.data.length === 0 ? <p className="mt-4 text-sm text-slate-600">Aucune invitation.</p> :
          <ul className="mt-4 divide-y divide-slate-100">
            {list.data.map(item => <li key={item.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-slate-900">{item.name} <span className="text-sm font-normal text-slate-600">({ROLE[item.role] ?? item.role})</span></p>
                <p className="text-sm text-slate-600">{INVITATION_STATUS[item.status] ?? item.status}
                  {item.status === "PENDING" ? `, expire le ${date(item.expiresAt)}` : ""}
                  {item.status === "ACCEPTED" && item.acceptedAt ? ` le ${date(item.acceptedAt)}` : ""}</p>
              </div>
              {(item.status === "PENDING" || item.status === "EXPIRED") &&
                <button onClick={() => revoke(item)} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">Révoquer</button>}
            </li>)}
          </ul>)}
      </>}
    </section>
  );
}

export default function OrganizationPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Organisation</h1>
        <p className="mt-1 text-base text-slate-600">Domaines vérifiés et invitations de votre équipe.</p>
      </div>
      <Domains />
      <Invitations />
    </div>
  );
}
