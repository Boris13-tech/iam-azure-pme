const fs = require('fs');
let f = 'scripts/soak/run-soak.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/"soak1@example.com"/g, '`soak1-${randomUUID()}@example.com`');
c = c.replace(/"soak2@example.com"/g, '`soak2-${randomUUID()}@example.com`');
c = c.replace(/"soak3@example.com"/g, '`soak3-${randomUUID()}@example.com`');
fs.writeFileSync(f, c);
