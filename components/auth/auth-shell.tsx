import React from "react";
import { Fingerprint, KeyRound, Layers, ScrollText } from "lucide-react";
import { LuxiaLogo } from "@/components/brand/luxia-logo";

// Every page before sign-in (sign-in, sign-up, recovery, invitation) uses this frame: the brand panel of
// luxia-it.com on the left, the task on the right. The panel states only what is true in Production today.
const PROOFS = [
  { icon: Fingerprint, title: "Clés d’accès", text: "Connexion sans mot de passe, résistante à l’hameçonnage." },
  { icon: Layers, title: "Organisations isolées", text: "Chaque organisation est séparée par la base de données elle-même." },
  { icon: ScrollText, title: "Journal inaltérable", text: "Chaque action d’administration est tracée dans un journal en ajout seul." },
  { icon: KeyRound, title: "Sauvegardes chiffrées", text: "Copies indépendantes, chiffrées, restaurations testées." },
];

/** Decorative network, as on luxia-it.com: fixed lines and nodes, no animation. */
function Network() {
  const nodes: Array<[number, number]> = [[60, 80], [180, 40], [300, 120], [420, 60], [520, 180], [380, 240], [240, 210], [110, 260], [460, 330], [300, 360], [160, 390], [540, 420]];
  const links: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 4], [2, 6], [6, 5], [5, 4], [6, 7], [5, 8], [8, 9], [9, 10], [7, 10], [8, 11], [0, 7], [2, 5]];
  return (
    <svg className="lx-auth__network" viewBox="0 0 600 460" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      {links.map(([a, b]) => <line key={`${a}-${b}`} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} />)}
      {nodes.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i % 4 === 2 ? 3.5 : 2} />)}
    </svg>
  );
}

export function AuthShell({ title, description, children, footer }: {
  title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div className="lx-auth">
      <aside className="lx-auth__brand" aria-label="LUXIA Identity">
        <Network />
        <div className="lx-auth__brand-inner">
          <LuxiaLogo onDark />
          <div className="lx-auth__pitch">
            <p className="lx-auth__eyebrow"><span className="lx-dot" aria-hidden="true" />LUXIA Identity · bêta privée, sur invitation</p>
            <p className="lx-auth__headline">Gouvernez qui accède à quoi. Prouvez chaque décision.</p>
          </div>
          <ul className="lx-auth__proofs">
            {PROOFS.map(({ icon: Icon, title: proofTitle, text }) => (
              <li key={proofTitle}>
                <span className="lx-auth__proof-icon"><Icon size={18} strokeWidth={1.8} aria-hidden /></span>
                <span><b>{proofTitle}</b><small>{text}</small></span>
              </li>
            ))}
          </ul>
          <p className="lx-auth__legal">© LUXIA-IT · Identité &amp; confiance</p>
        </div>
      </aside>
      <main className="lx-auth__main">
        <div className="lx-auth__panel">
          <div className="lx-auth__mobile-logo"><LuxiaLogo /></div>
          <header className="lx-auth__header">
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </header>
          {children}
          {footer && <div className="lx-auth__footer">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

export function AuthAlert({ children, tone = "danger" }: { children: React.ReactNode; tone?: "danger" | "success" }) {
  return <div className={`lx-alert lx-alert--${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}
