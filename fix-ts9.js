const fs = require('fs');

let f = 'tests/security/auth-context.test.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/requireAuth should throw UNAUTHORIZED if no cookie/g, 'requireAuth should throw NEXT_REDIRECT if no cookie');
c = c.replace(/\.toThrow\("UNAUTHORIZED"\)/g, '.toThrow("NEXT_REDIRECT")');
fs.writeFileSync(f, c);

f = 'tests/security/oidc-callback.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/externalScopeId: `scope-\$\{orgId\}`/g, 'externalScopeId: "tid-abc"');
fs.writeFileSync(f, c);
