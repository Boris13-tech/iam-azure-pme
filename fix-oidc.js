const fs = require('fs');
let f = 'tests/security/oidc-callback.test.ts';
let c = fs.readFileSync(f, 'utf8');
const replacement = `
const { mockCookieSet } = vi.hoisted(() => ({ mockCookieSet: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: mockCookieSet,
  })),
  headers: vi.fn(() => ({
    get: vi.fn(() => null),
  })),
}));

`;
if (!c.includes('next/headers"')) {
  c = c.replace('describe("OIDC Callback Security",', replacement + 'describe("OIDC Callback Security",');
}

const oldAssertion = `    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("luxia_session=");`;
const newAssertion = `    expect(mockCookieSet).toHaveBeenCalled();
    const callArgs = mockCookieSet.mock.calls[0];
    expect(callArgs[0]).toBe("luxia_session");`;
c = c.replace(oldAssertion, newAssertion);

fs.writeFileSync(f, c);
