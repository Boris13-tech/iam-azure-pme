# Threat model: <change or capability>

| Item | Value |
|---|---|
| Change | PR(s), design, commit range |
| Class | A |
| Author, date | |
| Reviewed by (at INDEPENDENTLY REVIEWED) | |
| Public / private split | Threats whose mitigation is not in place and that could help an attacker are recorded only in the private record; here they appear as `PRIVATE-n` |

## 1. What is being built
Two or three sentences, plus a data-flow sketch: actors, components, stores, external services.

## 2. Assets
What an attacker wants: authority, sessions, another organization's data, secrets, the journal's integrity, availability of sign-in.

## 3. Trust boundaries crossed
| Registry ID | Boundary | New or changed? |
|---|---|---|

## 4. Threats
One row per threat. STRIDE per boundary, plus the identity abuse cases: mix-up, replay, confused deputy, account linking, cross-tenant, downgrade, enumeration, race.

| ID | Boundary | Category | Threat (what the attacker does) | Mitigation | Test ID(s) | Residual risk | Owner |
|---|---|---|---|---|---|---|---|
| T1 | | | | | | | |

## 5. Invariant check
| Invariant | Holds? | How (mechanism, test) |
|---|---|---|
| I1 Authority is LUXIA's alone | | |
| I2 Isolation enforced by the database | | |
| I3 Fail closed, answer generically | | |
| I4 No security action without evidence | | |
| I5 Secrets referenced, never exposed | | |
| I6 Continuity: no lock-out, no silent data loss | | |
| I7 Gated and reversible | | |

## 6. Failure modes (availability)
| Dependency | Failure | Behaviour | Test ID |
|---|---|---|---|

## 7. Accepted residual risks
| Risk | Why accepted | Accepted by (operator, date) | Review date |
|---|---|---|---|

## 8. Refresh
Re-open this model on: a new boundary, a new dependency or provider, an incident, a review finding.
