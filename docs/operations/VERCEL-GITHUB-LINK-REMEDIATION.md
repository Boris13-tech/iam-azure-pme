# Vercel / GitHub project-link remediation

## Diagnosis

- GitHub homepage before remediation: `https://iam-azure-pme.vercel.app`.
- The domain belonged to the correct Vercel project ID (`prj_dZ6YOYRdONsicgWdlmofh7NwtoSP`) but was aliased to production deployment `dpl_DptFAVhKjpAFx1Gvw5uto2hTM5vg`.
- That deployment had a zero-duration root build and served the unrelated static “Edimo Artisan Électricien & BTP” application.
- Git integration is active and current Preview deployments clone `github.com/Boris13-tech/iam-azure-pme`, branch `security/phase-5e3-dependency-hardening`, with the expected commit SHA and Next.js build.
- Therefore the defect is a stale/misdirected production alias created by an unrelated manual deployment, not an application redirect.

## Canonical target rule

The stable canonical URL remains `https://iam-azure-pme.vercel.app`. It may be assigned only to a READY production deployment built from this repository after CI passes. A Preview deployment must not be promoted because it was built with Preview/staging environment selection.

## Environment remediation

Generic `STAGING_*` variables injected into Vercel Preview by an integration were removed because they were unused and included migration-capable/unpooled database material. The branch-scoped pooled `DATABASE_URL` and the existing branch-scoped staging application configuration were preserved. Migration/admin connectivity remains outside Vercel runtime.

## Verification gate

After deployment, verify: Vercel project and deployment ownership; production target and READY status; source repository/SHA; TLS; zero cross-project redirects; `/` resolving within the canonical host to the LUXIA login flow; staging Preview unchanged; and GitHub homepage equal to the canonical URL.
