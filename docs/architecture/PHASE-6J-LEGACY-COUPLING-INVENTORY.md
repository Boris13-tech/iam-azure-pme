# Phase 6J legacy coupling inventory

Status: inventoried and contained; removal is explicitly deferred beyond Identity v1 certification.

## Runtime hotspots

| Hotspot | Remaining coupling | Containment / disposition |
|---|---|---|
| `prisma/schema.prisma` (`User.azureId`, `User`, `Role`, `Permission`, `UserRole`, `RolePermission`, `LegacyUserBridge`) | Phase 5 compatibility data model | Retain until a separately gated, reversible retirement migration proves there are no unmapped users, grants, sessions, or audit references. |
| `app/api/users/route.ts` and `app/api/users/[id]/route.ts` | Legacy user response shape, bridge lookup, `azureId`, Graph compatibility facade | Keep API behavior stable. Replace in a later API-versioned slice after consumers move to Subject/IdentityAccount identifiers. |
| `lib/graph.ts` | Microsoft-named compatibility facade and legacy `User.azureId` synchronization | Provider SDK calls are already behind `MicrosoftEntraAdapter`; retire only after the user API no longer exposes the legacy model. |
| `lib/auth/legacy-auth-adapter.ts`, `lib/db/legacy-user-mapper.ts` | Subject-to-legacy mapping and migration bridge | Required rollback/compatibility seam. Instrument usage, then retire after a zero-use observation window. |
| `lib/auth/dual-write-service.ts`, `lib/auth/backfill-service.ts`, `lib/auth/reconciliation-service.ts`, `lib/auth/legacy-permission-map.ts` | Phase 5 migration and reconciliation path | Dormant under native authorization; retain as operational rollback tooling until retirement gate. |
| `lib/auth/providers/entra.ts` and `app/auth/*` | Entra-named compatibility facade and routes | OIDC implementation is adapter-confined. Add provider-neutral route selection before renaming/removing existing routes. |
| `app/login/page.tsx`, `app/dashboard/layout.tsx` | Microsoft/Entra-specific product copy | UX debt only; no canonical identity or authorization dependency. |
| `lib/jwt.ts`, `lib/permissions.ts`, `app/api/dashboard/route.ts` | Legacy compatibility exports/lookups | Keep behind the native authorization gateway; remove only with consumer and rollback evidence. |
| `GRAPH_*` / `NEXT_PUBLIC_GRAPH_*` fallbacks in the Entra connection resolver | Environment-era Entra configuration | Supported only as a compatibility fallback. New connections use connection-scoped secret references. |

## Boundary result

- Canonical identity remains `Subject`; external identifiers remain in `IdentityAccount` or provider projections.
- Core identity and authorization modules do not import Microsoft, Google, AWS, GitHub, LDAP, AD, or Samba SDKs.
- Provider outages do not mutate or delete canonical subjects.
- The remaining coupling is compatibility surface, migration machinery, provider implementation, or UI wording—not core identity ownership.

## Retirement gate

Legacy removal requires all of: zero bridge misses; zero legacy authorization reads for the observation window; export/restore coverage for referenced records; an API consumer migration; tested rollback; and an additive deprecation release before any destructive schema work.
