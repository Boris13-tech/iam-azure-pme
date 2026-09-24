const fs = require('fs');
let f = 'lib/auth/dual-write-service.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(
  /SELECT pg_advisory_xact_lock\(hashtext\('dualwrite_' \|\| \$1\)\)/g,
  "SELECT pg_advisory_xact_lock(hashtext('dualwrite'), hashtext($1))"
);
fs.writeFileSync(f, c);
