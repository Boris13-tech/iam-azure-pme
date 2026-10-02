import { verifyMicrosoftEntraToken } from "./provider-adapters/implementations/microsoft-entra/token-verifier";

/** Compatibility facade retained during the Phase 6B migration. */
export const verifyToken = verifyMicrosoftEntraToken;
