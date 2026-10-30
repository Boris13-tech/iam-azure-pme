// temporary probe (not committed)
import { test } from "@playwright/test";
import { issueSignupCode } from "./support/local-db";
const probe = async (label: string) => {
  const t = Date.now();
  try { await issueSignupCode(); console.log(label, "ok", Date.now() - t); } catch (e) { console.log(label, "ERR", Date.now() - t, String((e as Error).message).slice(-70)); }
};
test("no page", async () => { await probe("nopage"); await probe("nopage2"); });
test("with page", async ({ page }) => { await probe("page-before-goto"); await page.goto("/login"); await probe("page-after-goto"); });
