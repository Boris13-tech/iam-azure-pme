const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');
ts = ts.replace(/isGlobal: true/g, 'isCustom: false');
fs.writeFileSync('scripts/e2e-http.ts', ts);
