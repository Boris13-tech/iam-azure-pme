import type { Registration } from "./resource-owner-bootstrap";
// Operator-reviewed, immutable bytes + detached human attestation only.
// Empty until runner certification and a NEW human approval. Never populate from env/HTTP.
export const PRODUCTION_REGISTRATIONS: readonly Registration[] = Object.freeze([]);
