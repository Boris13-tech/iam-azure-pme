const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');
ts = ts.replace('tenantId: "dummy"', 'tenantId: "common"');
// and I will also adjust the output to exactly match the requested formatting
ts = ts.replace('console.log("✅ /login?error=... works");', 'console.log("/login?error                  PASS");');
ts = ts.replace('console.log("✅ /auth/login flow generates correct state & PKCE");', 'console.log("/auth/login + state/PKCE      PASS");');
ts = ts.replace('console.log("✅ authenticated API allows access");', 'console.log("authenticated API            PASS");');
ts = ts.replace('console.log("✅ invalid session denies access");', 'console.log("invalid session deny         PASS");');
ts = ts.replace('console.log("✅ PATCH /api/users/[id] async params work");', 'console.log("PATCH /api/users/[id]         PASS");');
ts = ts.replace('console.log("✅ DELETE /api/users/[id] async params work");', 'console.log("DELETE /api/users/[id]        PASS");');
ts = ts.replace('console.log("✅ PATCH /api/roles/[id] global freeze applied");', 'console.log("global Role freeze           PASS");');
ts = ts.replace('console.log("✅ /auth/logout successfully revokes session and rejects token reuse");', 'console.log("logout revoke                PASS\\ntoken reuse rejected         PASS");');
fs.writeFileSync('scripts/e2e-http.ts', ts);
