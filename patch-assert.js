const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');
ts = ts.replace(/assert\(apiRolesRes.status === 200, "Should allow access with valid session cookie, got " \+ apiRolesRes.status\);/, 'assert(apiRolesRes.status === 200, "Should allow access with valid session cookie, got " + apiRolesRes.status + " " + await apiRolesRes.text());');
fs.writeFileSync('scripts/e2e-http.ts', ts);
