// npm audit for CI: fails on high and critical advisories in the production
// dependencies, except those listed below. Each exception says why it does
// not affect the library and when to look again; after that date it fails CI
// again. Moderate findings never fail CI (see .github/workflows/ci.yml).
import { execFileSync } from "node:child_process";

const EXCEPTIONS = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    until: "2027-01-31",
    reason:
      "picomatch ReDoS through extglobs, with no patched release yet. The library never imports picomatch; Sentry's build plugin, vite, and vitest match only the project's own glob patterns with it.",
  },
];

const BLOCKING = new Set(["high", "critical"]);

let output;
try {
  output = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  // npm audit exits with 1 when it finds anything; the report is still on stdout.
  output = error.stdout;
}
const report = JSON.parse(output);
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

// Advisories by URL; packages that are only affected through a dependency
// list that dependency's name instead of an advisory.
const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) {
    if (typeof via === "object" && BLOCKING.has(via.severity)) advisories.set(via.url, via);
  }
}

const today = new Date().toISOString().slice(0, 10);
let failed = false;
for (const [url, advisory] of advisories) {
  const exception = EXCEPTIONS.find((candidate) => url.endsWith(`/${candidate.id}`));
  if (exception && today <= exception.until) {
    console.log(`Allowed until ${exception.until}: ${advisory.severity} ${advisory.name} ${url}. ${exception.reason}`);
    continue;
  }
  failed = true;
  const expired = exception ? ` (exception expired on ${exception.until})` : "";
  console.error(`${advisory.severity} ${advisory.name} ${advisory.range}: ${advisory.title} ${url}${expired}`);
}
for (const exception of EXCEPTIONS) {
  if (![...advisories.keys()].some((url) => url.endsWith(`/${exception.id}`))) {
    console.log(`Exception ${exception.id} is no longer needed; remove it from scripts/audit.mjs.`);
  }
}
if (failed) process.exit(1);
console.log("npm audit: no high or critical advisories in the production dependencies, apart from the exceptions above.");
