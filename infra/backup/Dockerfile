# Backup job image for Azure Container Apps (docs/operations/BACKUP-ON-AZURE.md). Built by
# .github/workflows/backup-image.yml from the public repository, pushed to GHCR, run by digest. It holds the backup
# scripts and the backup PUBLIC key only: no secret, no private key. Secrets reach it at run time from the job.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# The PostgreSQL client must be at least the server's major version (backup.mjs refuses otherwise).
ARG PG_MAJOR=17
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl age \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node /work
ENV PG_BIN=/usr/lib/postgresql/${PG_MAJOR}/bin

COPY scripts/backup/ /app/scripts/backup/
# Encrypted files are written under /work, then uploaded; the replica is discarded after each run.
WORKDIR /work
USER node
ENTRYPOINT ["node", "/app/scripts/backup/backup.mjs"]
