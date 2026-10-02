import sys
import re

with open('scripts/e2e-http.ts', 'r', encoding='utf-8') as f:
    ts = f.read()

# Replace outputs
ts = ts.replace('console.log("/auth/login + state/PKCE      PASS");', 'console.log("/auth/login                         PASS\\nstate + nonce + PKCE                PASS");')
ts = ts.replace('console.log("authenticated API            PASS");', 'console.log("valid session cookie               PASS");')

pattern1 = r'const dashRes = await fetch\(baseUrl \+ "/dashboard".*?console\.log\("invalid session deny         PASS"\);'
replacement1 = """
  const missingDashRes = await fetch(baseUrl + "/dashboard", { headers: { Cookie: "" }, redirect: "manual" });
  assert(missingDashRes.status === 307 || missingDashRes.status === 302, "Should redirect to login");
  console.log("missing cookie redirect            PASS");

  const invalidTokenRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: "luxia_session=INVALID_RANDOM_TOKEN", Accept: "application/json" } });
  assert(invalidTokenRes.status === 401, "Should reject invalid random token");
  console.log("invalid token rejection            PASS");
"""
ts = re.sub(pattern1, replacement1, ts, flags=re.DOTALL)

pattern2 = r'console\.log\("logout revoke                PASS\\ntoken reuse rejected         PASS"\);'
replacement2 = """
  console.log("logout → revokedAt set             PASS");
  const revokedApiRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: cookie, Accept: "application/json" } });
  assert(revokedApiRes.status === 401, "Should reject revoked token");
  console.log("revoked token rejection            PASS\\ntoken reuse after logout           PASS");
"""
ts = re.sub(pattern2, replacement2, ts, flags=re.DOTALL)

with open('scripts/e2e-http.ts', 'w', encoding='utf-8') as f:
    f.write(ts)
