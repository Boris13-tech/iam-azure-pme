// Kept in its own module so that guards used by canonical administration can raise it without an
// import cycle. `canonical-administration.ts` re-exports it unchanged.
export class CanonicalAdminError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
    this.name = "CanonicalAdminError";
  }
}
