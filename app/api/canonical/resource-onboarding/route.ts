import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, jsonBody } from "../../../../lib/admin/http";
import { CanonicalAdminError } from "../../../../lib/admin/canonical-administration";
import * as service from "../../../../lib/resources/onboarding";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const auth = await requireAuth();
    const id = new URL(request.url).searchParams.get("operationId");
    const value = id ? await service.previewInternalOnboarding(auth, z.string().uuid().parse(id)) : await service.describeInternalOnboarding(auth);
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    // Explicit same-origin mutations, not a permissive missing-Origin fallback.
    const origin = request.headers.get("origin");
    if (!process.env.NEXT_PUBLIC_APP_URL || origin !== new URL(process.env.NEXT_PUBLIC_APP_URL).origin) {
      await service.recordOnboardingRequestDenied(auth, "INVALID_ORIGIN");
      throw new CanonicalAdminError("INVALID_ORIGIN", 403);
    }
    const body = await jsonBody(request, z.discriminatedUnion("command", [
      z.object({ command: z.literal("plan"), targetSubjectId: z.string().uuid(), validUntil: z.iso.datetime() }).strict(),
      z.object({ command: z.enum(["configure", "grant"]), operationId: z.string().uuid() }).strict(),
    ])).catch(async () => {
      await service.recordOnboardingRequestDenied(auth, "INVALID_REQUEST_BODY");
      throw new CanonicalAdminError("INVALID_REQUEST_BODY", 400);
    });
    const value = body.command === "plan" ? await service.planInternalOnboarding(auth, body.targetSubjectId, new Date(body.validUntil))
      : body.command === "configure" ? await service.configureInternalOnboarding(auth, body.operationId)
      : await service.requestInternalGrant(auth, body.operationId);
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
