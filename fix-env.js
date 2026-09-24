const fs = require('fs');
let c = `
DATABASE_URL="postgresql://app_user:app_password@localhost:5432/luxia_db?schema=public"
DATABASE_MIGRATION_URL="postgresql://prisma:prisma_password@localhost:5432/luxia_db?schema=public"
NEXT_PUBLIC_GRAPH_CLIENT_ID=
NEXT_PUBLIC_GRAPH_TENANT_ID=
`;
fs.writeFileSync('.env', c);
