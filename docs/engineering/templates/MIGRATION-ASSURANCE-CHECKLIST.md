# Migration assurance checklist: <migration name>

Standard, section 13. Every item is answered with evidence, or with "not applicable" and the reason.

| # | Item | Evidence |
|---|---|---|
| 1 | Expand-only: no DROP, no type narrowing, no data rewrite (otherwise a forward-only declaration approved by the operator) | |
| 2 | Header comment: purpose, design link, effect on the application already deployed, rollback file | |
| 3 | `SET lock_timeout`; locks taken and their duration stated | |
| 4 | New tables: FORCE row-level security plus policies; append-only triggers where they hold records; `app_user` privileges minimal and stated | |
| 5 | New functions: `REVOKE ALL … FROM PUBLIC` right after the body; pinned `search_path`; SECURITY DEFINER justified or absent; runtime grants mirrored in `scripts/ci/bootstrap-app-user.sql`; function-privilege gate updated | |
| 6 | Constraints survive dump and restore identically (no `BETWEEN` in a CHECK, deterministic definitions); CI backup round trip green | |
| 7 | Rollback script: refuses when in use, restores exactly, deletes its `_prisma_migrations` row; CI drill (exact restore, refusal, re-apply) | |
| 8 | Prisma schema edited by script and validated (`prisma format` is never run on the whole schema) | |
| 9 | Fresh-clone rehearsal of Production: BEFORE, APPLY, AFTER, ROLLBACK, REAPPLY; sealed evidence; Production proven unchanged; clone deleted after verification | |
| 10 | Production gate prepared with the gate template; next backup verified with its counts of tables and migrations | |
| 11 | Never edited after running in any shared environment; corrections are new migrations | |
