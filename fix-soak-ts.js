const fs = require('fs');
let f = 'scripts/soak/run-soak.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace('import crypto from "crypto";', 'import * as crypto from "crypto";');
c = c.replace('providerSubjectId: "oidc-sub-1"', 'externalObjectId: "oidc-sub-1"');
fs.writeFileSync(f, c);
