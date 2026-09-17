import { describe, it, expect } from "vitest";
import { ENTITLEMENT_CATALOG_V1 } from "../../lib/auth/entitlements-catalog";
import * as fs from "fs";
import * as path from "path";

// A simple static analyzer test ensuring all explicit checkPermission requests 
// exist in the native ENTITLEMENT_CATALOG_V1.
describe("Phase 5D.3 - Entitlement Contract Test", () => {
  it("application authorization requests must be a subset of ENTITLEMENT_CATALOG_V1", () => {
    function walk(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (let file of list) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
          results = results.concat(walk(file));
        } else if (file.endsWith(".ts") || file.endsWith(".tsx")) {
          results.push(file);
        }
      }
      return results;
    }

    const appDir = path.resolve(__dirname, "../../app");
    const files = walk(appDir);
    
    const requestedKeys = new Set<string>();
    
    // Look for checkPermission(auth, { action: "X", resource: "Y" })
    const regex = /checkPermission\([\s\S]*?\{\s*action:\s*["']([^"']+)["']\s*,\s*resource:\s*["']([^"']+)["']\s*\}\)/g;
    
    for (const f of files) {
      const content = fs.readFileSync(f, "utf8");
      let match;
      while ((match = regex.exec(content)) !== null) {
        requestedKeys.add(`${match[2]}.${match[1]}`);
      }
    }

    const unmappedKeys = Array.from(requestedKeys).filter(
      (key) => !(ENTITLEMENT_CATALOG_V1 as readonly string[]).includes(key)
    );

    expect(unmappedKeys, `Found requested capabilities not mapped in ENTITLEMENT_CATALOG_V1: ${unmappedKeys.join(", ")}`).toEqual([]);
  });
});
