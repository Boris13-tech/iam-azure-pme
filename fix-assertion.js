const fs = require('fs');
let f = 'tests/security/oidc-callback.test.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(
  'const setCookie = res.headers.get("set-cookie");\n    expect(setCookie).toContain("luxia_session=");',
  `expect(mockCookieSet).toHaveBeenCalledWith(
      "luxia_session",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: expect.any(Boolean),
        sameSite: "lax",
      })
    );`
);
fs.writeFileSync(f, c);
