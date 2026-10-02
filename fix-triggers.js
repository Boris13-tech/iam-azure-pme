const fs = require('fs');
let f = 'prisma/migrations/20260917141000_global_role_safety_hardening/migration.sql';
let c = fs.readFileSync(f, 'utf8');

c = c.replace('BEFORE UPDATE OR DELETE ON "Role"', 'BEFORE INSERT OR UPDATE OR DELETE ON "Role"');
c = c.replace('BEFORE UPDATE OR DELETE ON "Permission"', 'BEFORE INSERT OR UPDATE OR DELETE ON "Permission"');

fs.writeFileSync(f, c);
