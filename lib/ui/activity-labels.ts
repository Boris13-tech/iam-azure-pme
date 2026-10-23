// Readable French labels for canonical audit operations and results. Client-safe (no server imports).
// Unknown codes are never guessed: the UI shows a neutral label and keeps the code available as a tooltip.

/** Start of every label of a LUXIA operator action (B4, B5). */
export const OPERATOR_ACTION_PREFIX = "Action opérateur LUXIA : ";

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
  // Provider connection lifecycle (sovereign providers, F2)
  "PROVIDER.CONNECTION.PLAN": "Changement de fournisseur préparé", "PROVIDER.CONNECTION.DISABLE": "Fournisseur désactivé",
  "PROVIDER.CONNECTION.ACTIVATE": "Fournisseur réactivé", "PROVIDER.CONNECTION.QUARANTINE": "Fournisseur mis en quarantaine, sessions révoquées",
  "PROVIDER.CONNECTION.RELEASE": "Fournisseur sorti de quarantaine (reste désactivé)",
  "PROVIDER.CONNECTION.TEST": "Fournisseur testé (découverte et clés)",
  "RESOURCE.CREATE": "Ressource créée", "RESOURCE.UPDATE": "Ressource modifiée", "RESOURCE.CATALOG.CREATE": "Ressource créée",
  "RESOURCE.CATALOG.UPDATE": "Ressource modifiée", "RESOURCE.SCOPE.CREATE": "Périmètre créé", "RESOURCE.ENTITLEMENT.CREATE": "Droit créé",
  "RESOURCE.ENTITLEMENT.REVOKE": "Droit retiré", "SOD.POLICY.CREATE": "Politique de séparation créée", "SOD.POLICY.UPDATE": "Politique de séparation modifiée",
  "SOD.RULE.CREATE": "Règle de séparation créée", "SOD.RULE.DISABLE": "Règle de séparation désactivée", "SOD.EVALUATE": "Séparation des tâches vérifiée",
  "ACCESS_REVIEW.CAMPAIGN.CREATE": "Campagne de revue créée", "ACCESS_REVIEW.CAMPAIGN.COMPLETE": "Campagne de revue clôturée",
  "ACCESS_REVIEW.ITEM.KEEP": "Accès conservé après revue", "ACCESS_REVIEW.ITEM.REVOKE": "Accès retiré après revue",
  "SESSION.SIGN_OUT": "Déconnexion", "LOCAL_AUTHENTICATOR.ENROLL": "Clé d’accès ajoutée",
  "ORGANIZATION.CREATE": "Organisation créée",
  "DOMAIN.ADD": "Domaine ajouté", "DOMAIN.CHECK": "Domaine contrôlé", "INVITATION.CREATE": "Invitation créée",
  "INVITATION.REVOKE": "Invitation révoquée", "INVITATION.ACCEPT": "Invitation acceptée",
  "RESOURCE.AUTHORIZATION.CHECK": "Autorisation vérifiée", "RESOURCE.CAPABILITY.READ": "Accès à la ressource de test vérifié",
  // Recovery codes and recovery sign-in (First Admin / Break-glass v1, B2)
  "RECOVERY_CODES.GENERATE": "Codes de récupération créés", "RECOVERY_CODES.REVOKE": "Codes de récupération révoqués",
  "RECOVERY.SIGN_IN": "Connexion par code de récupération", "RECOVERY.PASSKEY_ENROLLED": "Clé d’accès remplacée après une récupération",
  // LUXIA operator actions on the organization (B4). Always prefixed, so a customer tells them apart from its own administrators.
  "BREAK_GLASS.ORGANIZATION.SUSPEND": `${OPERATOR_ACTION_PREFIX}organisation suspendue`,
  "BREAK_GLASS.ORGANIZATION.REACTIVATE": `${OPERATOR_ACTION_PREFIX}organisation réactivée`,
  "BREAK_GLASS.ORGANIZATION.CLOSE": `${OPERATOR_ACTION_PREFIX}organisation fermée définitivement`,
  "BREAK_GLASS.SESSION.REVOKE": `${OPERATOR_ACTION_PREFIX}sessions révoquées`,
  "BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE": `${OPERATOR_ACTION_PREFIX}compte désactivé`,
  "BREAK_GLASS.DOMAIN.RELEASE": `${OPERATOR_ACTION_PREFIX}domaine libéré`,
  "BREAK_GLASS.RECOVERY_INVITATION.ISSUE": `${OPERATOR_ACTION_PREFIX}invitation d’administrateur de secours émise`,
  // G1 (LUXIA Key decision P4): correction of an unproven "hardware-bound" claim on passkeys enrolled before #64.
  "OPERATOR.AUTHENTICATOR.ASSURANCE_CORRECTION": `${OPERATOR_ACTION_PREFIX}niveau de garantie de clés d’accès corrigé`,
  "OPERATOR.AUTHENTICATOR.ASSURANCE_CORRECTION.REVERT": `${OPERATOR_ACTION_PREFIX}correction du niveau de garantie annulée`,
  // Consultations (read events)
  "AUDIT.READ": "Journal d’audit consulté", "DASHBOARD.POSTURE.READ": "Vue d’ensemble consultée", "SUBJECT.READ": "Identités consultées",
  "SESSION.READ": "Sessions consultées", "ASSIGNMENT.READ": "Accès consultés", "IDENTITY_ACCOUNT.READ": "Comptes consultés",
  "PROVIDER.READ": "Fournisseurs consultés", "RESOURCE.READ": "Ressource consultée", "RESOURCE.CATALOG.READ": "Ressources consultées",
  "RESOURCE.SCOPE.READ": "Périmètres consultés", "RESOURCE.ENTITLEMENT.READ": "Droits consultés", "RESOURCE.ASSIGNMENT.READ": "Accès aux ressources consultés",
  "RESOURCE.AUDIT.READ": "Historique des ressources consulté", "SOD.POLICY.READ": "Politiques de séparation consultées",
  "SOD.CONFLICT.READ": "Attributions bloquées consultées",
  "DOMAIN.READ": "Domaines consultés", "INVITATION.READ": "Invitations consultées", "ONBOARDING.CHECKLIST.READ": "Mise en route consultée",
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

/** Sign-in labels (Security Journal v1). Entra is "attestée par Microsoft": never MFA (decision S1). */
export const SIGN_IN_METHOD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  FEDERATED_OIDC: "Microsoft Entra ID", PASSKEY: "Clé d’accès", SECURITY_KEY: "Clé de sécurité", TOTP: "Code à usage unique",
  RECOVERY_CODE: "Code de récupération",
});
export const ASSURANCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  PROVIDER_ATTESTED: "Connexion attestée par Microsoft", PHISHING_RESISTANT: "Résistante à l’hameçonnage", STANDARD: "Standard",
  RECOVERY_CODE: "Faible, code à usage unique, accès limité à l’ajout d’une clé d’accès",
});
export const REFUSAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  SUBJECT_NOT_ACTIVE: "Identité non active", IDENTITY_ACCOUNT_DISABLED: "Compte désactivé",
  RECOVERY_CODE_INVALID: "Code de récupération invalide ou déjà utilisé",
  PROVIDER_CONNECTION_NOT_ACTIVE: "Fournisseur d’identité désactivé ou en quarantaine",
});
