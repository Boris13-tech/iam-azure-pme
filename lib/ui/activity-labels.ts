// Readable French labels for canonical audit operations and results. Client-safe (no server imports).
// Unknown codes are never guessed: the UI shows a neutral label and keeps the code available as a tooltip.

export const OPERATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "RESOURCE.ONBOARDING.BOOTSTRAP": "Accès initial accordé", "RESOURCE.ONBOARDING.BOOTSTRAP.REVOKE": "Accès initial révoqué",
  "RESOURCE.ONBOARDING.BOOTSTRAP.DENIED": "Accès initial refusé", "RESOURCE.ONBOARDING.CONFIGURE": "Ressource configurée",
  "RESOURCE.ONBOARDING.PLAN": "Intégration de ressource préparée", "RESOURCE.ONBOARDING.PLAN.DENIED": "Intégration de ressource refusée",
  "RESOURCE.ONBOARDING.REQUEST.DENIED": "Demande d’intégration refusée",
  "ROLE.GOVERNANCE.GRANT": "Droits de gouvernance accordés", "ROLE.GOVERNANCE.REVOKE": "Droits de gouvernance retirés",
  "ROLE_BUNDLE.GRANT": "Rôle d’administration accordé", "LOCAL_IDENTITY.RECOVERY_UNLOCK": "Compte local déverrouillé",
  "ASSIGNMENT.GRANT": "Accès accordé", "ASSIGNMENT.REVOKE": "Accès révoqué", "ASSIGNMENT.DENIED.SOD": "Accès bloqué (séparation des tâches)",
  "RESOURCE.ASSIGNMENT.GRANT": "Accès à une ressource accordé", "RESOURCE.ASSIGNMENT.REVOKE": "Accès à une ressource révoqué",
  "RESOURCE.ASSIGNMENT.UPDATE": "Accès à une ressource modifié", "AUTHORIZATION.DENIED": "Action refusée",
  "SESSION.REVOKE": "Session révoquée", "IDENTITY_ACCOUNT.DISABLE": "Compte désactivé", "IDENTITY_ACCOUNT.LINK": "Compte lié",
  "SUBJECT.CREATE": "Identité créée", "SUBJECT.UPDATE": "Identité modifiée", "PROVIDER.CREATE": "Fournisseur ajouté", "PROVIDER.UPDATE": "Fournisseur modifié",
  "RESOURCE.CREATE": "Ressource créée", "RESOURCE.UPDATE": "Ressource modifiée", "RESOURCE.CATALOG.CREATE": "Ressource créée",
  "RESOURCE.CATALOG.UPDATE": "Ressource modifiée", "RESOURCE.SCOPE.CREATE": "Périmètre créé", "RESOURCE.ENTITLEMENT.CREATE": "Droit créé",
  "RESOURCE.ENTITLEMENT.REVOKE": "Droit retiré", "SOD.POLICY.CREATE": "Politique de séparation créée", "SOD.POLICY.UPDATE": "Politique de séparation modifiée",
  "SOD.RULE.CREATE": "Règle de séparation créée", "SOD.RULE.DISABLE": "Règle de séparation désactivée", "SOD.EVALUATE": "Séparation des tâches vérifiée",
  "ACCESS_REVIEW.CAMPAIGN.CREATE": "Campagne de revue créée", "ACCESS_REVIEW.CAMPAIGN.COMPLETE": "Campagne de revue clôturée",
  "ACCESS_REVIEW.ITEM.KEEP": "Accès conservé après revue", "ACCESS_REVIEW.ITEM.REVOKE": "Accès retiré après revue",
  "RESOURCE.AUTHORIZATION.CHECK": "Autorisation vérifiée", "RESOURCE.CAPABILITY.READ": "Accès à la ressource de test vérifié",
  // Consultations (read events)
  "AUDIT.READ": "Journal d’audit consulté", "DASHBOARD.POSTURE.READ": "Vue d’ensemble consultée", "SUBJECT.READ": "Identités consultées",
  "SESSION.READ": "Sessions consultées", "ASSIGNMENT.READ": "Accès consultés", "IDENTITY_ACCOUNT.READ": "Comptes consultés",
  "PROVIDER.READ": "Fournisseurs consultés", "RESOURCE.READ": "Ressource consultée", "RESOURCE.CATALOG.READ": "Ressources consultées",
  "RESOURCE.SCOPE.READ": "Périmètres consultés", "RESOURCE.ENTITLEMENT.READ": "Droits consultés", "RESOURCE.ASSIGNMENT.READ": "Accès aux ressources consultés",
  "RESOURCE.AUDIT.READ": "Historique des ressources consulté", "SOD.POLICY.READ": "Politiques de séparation consultées",
  "SOD.CONFLICT.READ": "Attributions bloquées consultées",
});

export const RESULT_LABELS: Readonly<Record<string, string>> = Object.freeze({ SUCCESS: "Réussi", DENIED: "Refusé", FAILURE: "Échec" });

/** Readable label, or null when the code is unknown (callers show a neutral label, never a guess). */
export function operationLabel(operation: string): string | null {
  if (OPERATION_LABELS[operation]) return OPERATION_LABELS[operation];
  if (operation.endsWith(".DENIED")) {
    const base = OPERATION_LABELS[operation.slice(0, -".DENIED".length)];
    if (base) return `${base} (refusé)`;
  }
  return null;
}
