const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');
ts = ts.replace('const deletedSession = await adminPrisma.session.findUnique({ where: { id: session.id } });\n  assert(!deletedSession, \"Session should be deleted from DB\");', 'const revokedSession = await adminPrisma.session.findUnique({ where: { id: session.id } });\n  assert(revokedSession, "Session record should be preserved");\n  assert(revokedSession.revokedAt !== null, "Session should be marked as revoked");\n  const resolved = await SessionStore.getSession(rawToken);\n  assert(resolved === null, "SessionStore should not resolve revoked session");');
fs.writeFileSync('scripts/e2e-http.ts', ts);
