const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');
ts = ts.replace(/externalScopeId: "dummy"/g, 'externalScopeId: "common"');
fs.writeFileSync('scripts/e2e-http.ts', ts);
