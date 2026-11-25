import { NextResponse } from "next/server";

const RETIRED_HEADERS = Object.freeze({
  "Cache-Control": "no-store, private",
});

// G2-R01 (F-01): Phase 1-4 legacy endpoints (/api/users, /api/roles, /api/settings, /api/audit, /api/graph)
// have been superseded by /api/canonical/** under forced PostgreSQL RLS (withTenantDb).
// Every HTTP verb fails closed with a constant 410 Gone payload and touches neither the database nor Graph.
export function retiredLegacyApiResponse(): NextResponse {
  return NextResponse.json(
    { error: "LEGACY_API_RETIRED" },
    { status: 410, headers: RETIRED_HEADERS },
  );
}
