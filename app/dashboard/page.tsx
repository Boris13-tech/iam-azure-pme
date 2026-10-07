"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Boxes, Network, ShieldCheck, Users } from "lucide-react";
type DashboardData = {
  activeUsers: number | null; activeSessions: number | null;
  protectedResources: number | null; providerScopes: number | null; rolesConfigured: number | null;
  entitlements: string[];
  recentEvents: { id: string; operation: string; result: string; occurredAt: string }[];
};
const metrics = [
  ["Identités actives", "activeUsers", Users, "blue"],
  ["Ressources actives", "protectedResources", Boxes, "indigo"],
  ["Sessions actives", "activeSessions", Activity, "rose"],
  ["Providers configurés", "providerScopes", Network, "cyan"],
  ["Bundles d’accès actifs", "rolesConfigured", ShieldCheck, "emerald"],
] as const;
const tools = [
  ["resources.read", "/dashboard/resources", "Ressources", "Applications, APIs, services, appareils, workloads et agents IA"],
  ["sod.read", "/dashboard/governance/sod", "Séparation des tâches", "Politiques et conflits d’entitlements"],
  ["access_reviews.read", "/dashboard/governance/access-reviews", "Revues d’accès", "Campagnes et décisions sur les accès existants"],
] as const;
export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/dashboard", { signal: abort.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("DASHBOARD_UNAVAILABLE"); return response.json(); })
      .then(setData).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, []);
  return <div className="luxia-dashboard">
    <section className="luxia-hero"><div className="luxia-hero-copy">
      <small>LUXIA IDENTITY</small><h1>Identités, ressources et gouvernance</h1>
      <p>Données réelles de votre organisation et de votre tenant. Les outils visibles correspondent à vos droits canoniques.</p>
    </div></section>
    {failed ? <p role="alert">Les données sont indisponibles. Aucun indicateur estimé n’est affiché.</p> : !data ?
      <p role="status">Chargement des données du tenant…</p> : <>
      <section className="luxia-metrics">{metrics.filter(([, key]) => data[key] !== null).map(([label, key, Icon, tone]) =>
        <article className={`luxia-metric tone-${tone}`} key={key}><span className="metric-icon"><Icon size={24} /></span><div><small>{label}</small><strong>{data[key]}</strong></div></article>)}</section>
      <section className="luxia-panel"><header><h2>Resources & Governance</h2></header>
        {tools.filter(([permission]) => data.entitlements.includes(permission)).map(([, href, title, description]) =>
          <article key={href}><h3><Link href={href}>{title}</Link></h3><p>{description}</p></article>)}
        {!tools.some(([permission]) => data.entitlements.includes(permission)) && <p>Aucun outil de gouvernance n’est autorisé pour ce compte.</p>}
      </section>
      {data.entitlements.includes("audit.read") && <section className="luxia-panel activity-panel">
        <header><h2>Activité administrative réelle</h2><Link href="/dashboard/audit">Consulter l’audit</Link></header>
        {data.recentEvents.length === 0 ? <p>Aucun événement administratif disponible.</p> : data.recentEvents.map(event =>
          <article key={event.id}><b>{event.operation}</b><span> — {event.result}</span><time dateTime={event.occurredAt}> — {new Date(event.occurredAt).toLocaleString("fr-FR")}</time></article>)}
      </section>}
    </>}
  </div>;
}
