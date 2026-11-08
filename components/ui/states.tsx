import React from "react";
import { AlertTriangle, Inbox, Loader2, Lock } from "lucide-react";

// The four states every list or panel of the dashboard can be in. Loading and an error must never look like an
// empty organization, and a refusal is not an error: each has its own words and its own role for screen readers.
export function LoadingState({ label = "Chargement..." }: { label?: string }) {
  return <p className="lx-state" role="status"><Loader2 size={16} className="lx-spin" aria-hidden />{label}</p>;
}

export function ErrorState({ children, onRetry }: { children: React.ReactNode; onRetry?: () => void }) {
  return (
    <div className="lx-state lx-state--error" role="alert">
      <AlertTriangle size={16} aria-hidden /><span>{children}</span>
      {onRetry && <button type="button" className="lx-state__retry" onClick={onRetry}>Réessayer</button>}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="lx-state lx-state--empty"><Inbox size={16} aria-hidden />{children}</p>;
}

export function RestrictedState({ children = "Vous n’avez pas accès à ces informations." }: { children?: React.ReactNode }) {
  return <p className="lx-state lx-state--restricted"><Lock size={16} aria-hidden />{children}</p>;
}

/** Page title block, the same on every page of the dashboard. */
export function PageHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <header className="luxia-page-header">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </header>
  );
}
