#!/usr/bin/env node
/**
 * Fails the DAST job on ZAP findings at or above our threshold.
 *
 * ZAP's own exit code is unreliable across versions and modes, so the report is
 * parsed instead. A scan that produced no report at all fails rather than
 * passes - "no findings" and "never ran" must never look identical.
 */
import { readFileSync, existsSync } from "node:fs";

const REPORT = "zap-report.md";

if (!existsSync(REPORT)) {
  console.error(`${REPORT} not found - the scan did not complete. Failing closed.`);
  process.exit(1);
}

const report = readFileSync(REPORT, "utf8");

function count(label) {
  const pattern = new RegExp(String.raw`\|\s*` + label + String.raw`\s*\|\s*(\d+)\s*\|`, "i");
  const match = report.match(pattern);
  return match ? Number(match[1]) : 0;
}

const high = count("High");
const medium = count("Medium");

console.log(`ZAP findings - high: ${high}, medium: ${medium}`);

if (high > 0) {
  console.error("High severity findings present. See the uploaded report artifact.");
  process.exit(1);
}
if (medium > 0) {
  console.warn("Medium severity findings present - review before release.");
}
console.log("DAST threshold satisfied.");
