import { existsSync, readFileSync } from "node:fs";

type Gate = { id: string; required: boolean; result: "PASS" | "FAIL" | "NA"; evidence: string[] };
type Report = { version: string; profiles: Record<string, { result: "PASS" | "FAIL" | "NA" }>; gates: Gate[] };

const path = "docs/operations/identity-v1-certification.json";
const report = JSON.parse(readFileSync(path, "utf8")) as Report;
const failures: string[] = [];
if (report.version !== "1.0") failures.push("unsupported certification format");
for (const [profile, result] of Object.entries(report.profiles)) if (result.result !== "PASS") failures.push(`${profile}=${result.result}`);
for (const gate of report.gates) {
  if (gate.required && gate.result !== "PASS") failures.push(`${gate.id}=${gate.result}`);
  if (gate.required && gate.evidence.length === 0) failures.push(`${gate.id}=missing evidence`);
  for (const evidence of gate.evidence.filter((item) => item.startsWith("file:"))) {
    const file = evidence.slice(5).split("#", 1)[0];
    if (!existsSync(file)) failures.push(`${gate.id}=missing ${file}`);
  }
}
if (failures.length) {
  console.error(`LUXIA Identity v1 certification FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`LUXIA Identity v1 certification PASS: ${Object.keys(report.profiles).join(", ")}; ${report.gates.length} gates`);
