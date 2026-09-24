const fs = require('fs');
let f = 'tests/security/oidc-callback.test.ts';
let c = fs.readFileSync(f, 'utf8');

const regex = /const setCookie = res\.headers\.get\("set-cookie"\);\s*expect\(setCookie\)\.toContain\("luxia_session="\);/g;

c = c.replace(regex, `expect(mockCookieSet).toHaveBeenCalledWith(
      "luxia_session",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: expect.any(Boolean),
        sameSite: "lax",
      })
    );`);

fs.writeFileSync(f, c);
