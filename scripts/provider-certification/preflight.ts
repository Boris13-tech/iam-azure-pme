export type Profile = "ENTRA" | "GOOGLE" | "OIDC";
export function preflight(profile: Profile, env: Record<string, string | undefined>) {
  const common = ["LUXIA_CERT_DATABASE_URL", "LUXIA_CERT_DATABASE_MIGRATION_URL",
    `LUXIA_CERT_${profile}_ORGANIZATION_ID`, `LUXIA_CERT_${profile}_TENANT_SCOPE_ID`,
    `LUXIA_CERT_${profile}_ACTOR_SUBJECT_ID`, `LUXIA_CERT_${profile}_CONNECTION_ID`,
    `LUXIA_CERT_${profile}_HTTP_SESSION_TOKEN`, `LUXIA_CERT_${profile}_FOREIGN_HTTP_SESSION_TOKEN`];
  const specific = profile === "ENTRA" ? ["LUXIA_CERT_ENTRA_CLIENT_ID", "LUXIA_CERT_ENTRA_CLIENT_SECRET", "LUXIA_CERT_ENTRA_TENANT_ID",
    "LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_ID", "LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_SECRET"]
    : profile === "GOOGLE" ? ["LUXIA_CERT_GOOGLE_CUSTOMER_ID", "LUXIA_CERT_GOOGLE_ACCESS_TOKEN", "LUXIA_CERT_GOOGLE_REVOKED_ACCESS_TOKEN"]
    : ["LUXIA_CERT_OIDC_ISSUER", "LUXIA_OIDC_ALLOWED_ISSUERS"];
  const missing = [...common, ...specific].filter(name => !env[name]?.trim());
  if (profile !== "OIDC" && env[`LUXIA_CERT_${profile}_CONSENT_CONFIRMED`] !== "true") missing.push(`LUXIA_CERT_${profile}_CONSENT_CONFIRMED`);
  if (profile === "OIDC" && env.LUXIA_CERT_OIDC_APPROVED !== "true") missing.push("LUXIA_CERT_OIDC_APPROVED");
  if (missing.length) return { ready: false, missing };
  for (const name of common.slice(0, 2)) {
    try {
      const url = new URL(env[name]!);
      if (!['ep-shy-shape-ah9l8gm8.c-3.us-east-1.aws.neon.tech','ep-shy-shape-ah9l8gm8-pooler.c-3.us-east-1.aws.neon.tech'].includes(url.hostname)
        || url.pathname !== '/luxia_provider_cert' || !['require','verify-full'].includes(url.searchParams.get('sslmode') ?? '')) return { ready:false, missing:['CERT_DATABASE_SCOPE_INVALID'] };
      if (name === common[0] && decodeURIComponent(url.username) !== 'app_user') return { ready:false, missing:['CERT_RUNTIME_ROLE_INVALID'] };
    } catch { return { ready:false, missing:['CERT_DATABASE_SCOPE_INVALID'] }; }
  }
  if (profile === 'OIDC' && !env.LUXIA_OIDC_ALLOWED_ISSUERS!.split(',').map(s => s.trim()).includes(env.LUXIA_CERT_OIDC_ISSUER!)) return { ready:false, missing:['CERT_ISSUER_NOT_ALLOWLISTED'] };
  return { ready:true, missing:[] };
}
