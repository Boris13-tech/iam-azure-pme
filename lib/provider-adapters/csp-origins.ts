// Adapter-layer CSP form-action allowlist for federated OIDC redirect chains (Rule R2).
// Pure constants (zero Node.js or database imports) so Edge middleware can import safely.
export const FEDERATED_CSP_FORM_ACTION_ORIGINS = [
  "https://login.microsoftonline.com",
] as const;