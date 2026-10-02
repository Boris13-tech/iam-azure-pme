const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');
ts = ts.replace(/name: "Global Administrator"/g, 'name: "Administrateur"');
fs.writeFileSync('scripts/e2e-http.ts', ts);
