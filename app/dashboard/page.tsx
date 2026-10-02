"use client";
import React, { useEffect, useState } from "react";
import { Activity, AppWindow, Bot, Boxes, Building2, ChevronRight, Cloud, Cuboid, Database, FileText, Fingerprint, Globe2, KeyRound, Laptop, Network, Radio, Server, Settings2, ShieldCheck, Sparkles, Users, Workflow } from "lucide-react";

type DashboardData = { activeUsers: number; activeSessions: number; protectedResources: number; providerScopes: number; rolesConfigured: number; graphData: unknown[] };
const metrics = [
  ["Identités actives", "activeUsers", Users, "blue"], ["Ressources protégées", "protectedResources", Boxes, "indigo"],
  ["Sessions actives", "activeSessions", Activity, "rose"], ["Providers connectés", "providerScopes", Network, "cyan"],
  ["Rôles canoniques", "rolesConfigured", ShieldCheck, "emerald"],
] as const;
const actors = [[Users,"Collaborateurs","Employés, équipes"],[Building2,"Partenaires","Prestataires, clients"],[Laptop,"Appareils & workspaces","Postes, mobiles, serveurs"],[Bot,"Agents IA","Identités non-humaines"],[Fingerprint,"Invités temporaires","Accès à durée limitée"]] as const;
const providers = [["▦","Microsoft Entra ID"],["G","Google Workspace"],["▤","LDAP / Active Directory"],["◉","OIDC générique"],["△","SAML"],["SCIM","SCIM"]] as const;
const resources = [[AppWindow,"Applications métiers","ERP, CRM, Finance, RH"],[Settings2,"APIs & services","APIs, microservices"],[Laptop,"Appareils & équipements","Postes, mobiles, IoT"],[Server,"Workloads & serveurs","VM, conteneurs, Kubernetes"],[FileText,"Documents & données","Partage sécurisé"],[Bot,"Agents IA","Applications et assistants IA"]] as const;

function ArchitectureItem({ icon: Icon, title, subtitle }: { icon: React.ElementType; title: string; subtitle: string }) {
  return <div className="architecture-item"><span><Icon size={18} /></span><div><b>{title}</b><small>{subtitle}</small></div></div>;
}
function Capability({ title, icon: Icon, items }: { title: string; icon: React.ElementType; items: string[] }) {
  return <section className="luxia-panel capability-card"><header><h2><Icon size={17}/>{title}</h2><a>Gérer</a></header><div>{items.map(item=><span key={item}>{item}</span>)}</div></section>;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>({ activeUsers: 0, activeSessions: 0, protectedResources: 0, providerScopes: 0, rolesConfigured: 0, graphData: [] });
  useEffect(() => { fetch("/api/dashboard").then(r => r.json()).then(v => !v.error && setData(v)).catch(() => undefined); }, []);
  return (
    <div className="luxia-dashboard">
      <section className="luxia-hero">
        <div className="luxia-hero-copy"><small>LUXIA IDENTITY</small><h1>Plan de contrôle souverain des identités,<br/>accès et ressources</h1><p>Une plateforme unifiée, sécurisée et multi-domaine pour les collaborateurs, partenaires, appareils, applications et agents IA.</p></div>
        <div className="luxia-hero-badges"><span><ShieldCheck/>Souveraineté<br/>des données</span><span><Globe2/>Multicloud &<br/>hybride</span><span><Settings2/>Mode<br/>déconnecté</span></div>
      </section>
      <div className="luxia-overview-grid">
        <div className="luxia-center-column">
          <section className="luxia-metrics">
            {metrics.map(([label,value,Icon,tone])=><article className={`luxia-metric tone-${tone}`} key={label}><span className="metric-icon"><Icon size={24}/></span><div><small>{label}</small><strong>{data[value]}</strong></div></article>)}
          </section>
          <section className="luxia-panel architecture-panel">
            <header><div><Workflow size={18}/><h2>Architecture de la plateforme</h2></div><span>Vue logique</span></header>
            <div className="architecture-grid">
              <div className="architecture-column"><h3>Acteurs & Identités</h3>{actors.map(([Icon,t,s])=><ArchitectureItem key={t} icon={Icon} title={t} subtitle={s}/>)}</div>
              <div className="architecture-flow-arrow">→</div>
              <div className="architecture-column provider-column"><h3><i className="status-dot"/> Sources d’identité / Providers</h3>{providers.map(([mark,label])=><div className="provider-item" key={label}><strong>{mark}</strong><span>{label}</span></div>)}</div>
              <div className="architecture-flow-arrow">→</div>
              <div className="luxia-core"><div className="core-title"><div className="core-mini-logo">▲</div><div><b>LUXIA <span>IDENTITY</span></b><small>Plan de contrôle souverain</small></div></div><div className="core-modules"><div><KeyRound/><b>Authentification & SSO</b><small>Multi-méthodes, zero trust</small></div><div><FileText/><b>Moteur de politiques</b><small>Règles, accès contextuels</small></div><div><Users/><b>Gestion des identités</b><small>Rôles, permissions, provisioning</small></div><div><Fingerprint/><b>Audit & traçabilité</b><small>Conformité en temps réel</small></div></div><div className="core-footer"><Radio size={18}/> Mode cloud, hybride ou déconnecté</div></div>
              <div className="architecture-flow-arrow">→</div>
              <div className="architecture-column"><h3>Ressources protégées</h3>{resources.map(([Icon,t,s])=><ArchitectureItem key={t} icon={Icon} title={t} subtitle={s}/>)}</div>
            </div>
          </section>
          <section className="luxia-capability-grid">
            <Capability title="Méthodes d’authentification" icon={Fingerprint} items={["LUXIA_LOCAL","Passkeys","MFA","OIDC","SAML","Mode hors-ligne"]}/>
            <Capability title="Providers d’identité" icon={Network} items={["Microsoft Entra ID","Google Workspace","LDAP / Active Directory","OIDC universel","SAML","SCIM"]}/>
            <Capability title="Contrôle d’accès" icon={KeyRound} items={["Rôles","Permissions","Affectations","Politiques d’accès","Accès conditionnel"]}/>
            <Capability title="Ressources" icon={Cuboid} items={["Applications","APIs & services","Appareils","Workloads","Documents","Agents IA"]}/>
          </section>
        </div>
        <aside className="luxia-right-rail">
          <section className="luxia-panel health-panel"><header><h2><ShieldCheck size={18}/> Santé des services</h2><a>Voir les détails</a></header>{[[Cloud,"Cloud"],[Server,"On-premise"],[Database,"Base souveraine"]].map(([Icon,label])=><div className="health-row" key={String(label)}><Icon size={22}/><div><b>{String(label)}</b><small>Services principaux</small></div><span>● Opérationnel</span></div>)}</section>
          <section className="luxia-panel alma-panel"><header><h2><Sparkles size={18}/> Assistant AI MA</h2><em>Bêta</em></header><p>Des recommandations pour renforcer votre posture d’identité et d’accès.</p><div className="recommendations"><b>3 recommandations prioritaires</b><ol><li>Activer le MFA pour les comptes à risque</li><li>Réviser les accès partenaires inactifs</li><li>Mettre à jour les politiques sensibles</li></ol></div><button>Voir toutes les recommandations <ChevronRight size={16}/></button></section>
          <section className="luxia-panel activity-panel"><header><h2><Activity size={18}/> Activité récente</h2><a>Voir tout</a></header>{["Connexion réussie","Accès application","Création d’utilisateur","Modification de politique","Tentative d’accès bloquée"].map((x,i)=><div className="activity-row" key={x}><span className={i===4?"danger":""}/><div><b>{x}</b><small>{i===4?"Règle de risque appliquée":"Action vérifiée"}</small></div><time>il y a {i*7+5} min</time></div>)}</section>
        </aside>
      </div>
    </div>
  );
}
