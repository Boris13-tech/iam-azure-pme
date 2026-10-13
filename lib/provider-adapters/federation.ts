// Provider types an organization may sign in through, besides LUXIA_LOCAL (the native provider). The core resolves
// connections through this list and never names a provider itself (sovereign design, rule R2). Generic OIDC and
// other profiles join it when their adapters exist (phases F4 and F6). The list is checked against the database
// enum where it is used (lib/auth/organization-login.ts), so this layer stays free of Prisma.
export const FEDERATED_SIGN_IN_PROVIDER_TYPES = ["MICROSOFT_ENTRA"] as const;
