const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');
ts = ts.replace(/Cookie: "luxia_session=INVALID_TOKEN"/g, 'Cookie: ""');
fs.writeFileSync('scripts/e2e-http.ts', ts);
