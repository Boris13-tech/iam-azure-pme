import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { requireAuth } from "../auth/require-auth";
import { checkPermission } from "../auth/authorization-gateway";
import type { AuthContext } from "../auth/authorization-engine";
import {
  CanonicalAdminError,
  newReadChangeId,
  recordDeniedAdminAccess,
} from "./canonical-administration";

export async function requireCanonicalAccess(
  resource: string,
  action: string,
): Promise<AuthContext> {
  const auth = await requireAuth();
  if (!(await checkPermission(auth, { resource, action }))) {
    try {
      await recordDeniedAdminAccess(auth, resource, action);
    } catch {
      // Authorization still fails closed if evidence persistence is unavailable.
    }
    throw new CanonicalAdminError("FORBIDDEN", 403);
  }
  return auth;
}

export function mutationChangeId(request: Request): string {
  const value = request.headers.get("x-luxia-change-id")?.trim();
  if (!value || value.length > 128) {
    throw new CanonicalAdminError("X_LUXIA_CHANGE_ID_REQUIRED", 400);
  }
  return value;
}

export const readChangeId = (operation: string) => newReadChangeId(operation);

export async function jsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) throw new CanonicalAdminError("INVALID_REQUEST_BODY", 400);
  return parsed.data;
}

export function canonicalAdminErrorResponse(error: unknown): NextResponse {
  if (error instanceof CanonicalAdminError) {
    return NextResponse.json({ error: error.code }, { status: error.httpStatus });
  }
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "INVALID_REQUEST_BODY" }, { status: 400 });
  }
  return NextResponse.json({ error: "CANONICAL_ADMIN_OPERATION_FAILED" }, { status: 500 });
}
