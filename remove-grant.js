const fs = require('fs');
let f = 'prisma/migrations/20260917140000_session_resolver_hardening/migration.sql';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  'GRANT EXECUTE ON FUNCTION resolve_session(TEXT) TO app_user;',
  ''
);

// Also remove the comment above it if present
c = c.replace(
  '-- 3. Grant execute exclusively to the runtime role\n\n',
  ''
);
c = c.replace(
  '-- 3. Grant execute exclusively to the runtime role\n',
  ''
);

fs.writeFileSync(f, c);
