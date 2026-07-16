// Unit tests for the shared CORS helper. Runs under Deno (`deno test`) or
// Node (`node --experimental-strip-types cors_logic_test.ts`).
//
// Regression: supabase-js attaches `apikey` and `x-client-info` (plus
// `authorization` and `content-type`) on every functions.invoke preflight. The
// browser aborts the request with "Request header field apikey is not allowed
// by Access-Control-Allow-Headers" unless all four are advertised.
import { corsHeaders } from "../_shared/http.ts";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string) {
  console.log((cond ? "PASS" : "FAIL") + ": " + msg);
  if (cond) passed++; else failed++;
}

const ORIGIN = "https://queenzclub.github.io";
const cors = corsHeaders(ORIGIN);
const allow = (cors["Access-Control-Allow-Headers"] || "")
  .split(",").map((h) => h.trim().toLowerCase());

// The four headers supabase-js sends on preflight must ALL be permitted.
for (const h of ["authorization", "x-client-info", "apikey", "content-type"]) {
  ok(allow.includes(h), `OPTIONS preflight permits '${h}'`);
}

// Strict origin behavior is unchanged: exact ALLOWED_ORIGIN, never '*',
// never a reflected arbitrary origin.
ok(cors["Access-Control-Allow-Origin"] === ORIGIN, "Allow-Origin is exactly ALLOWED_ORIGIN");
ok(cors["Access-Control-Allow-Origin"] !== "*", "Allow-Origin is never the wildcard '*'");
ok(corsHeaders("http://localhost:8000")["Access-Control-Allow-Origin"] === "http://localhost:8000",
  "Allow-Origin echoes only the configured origin (dev localhost), not an arbitrary Origin header");
ok(cors["Vary"] === "Origin", "Vary: Origin is set");

// Methods unchanged (preflight advertises POST + OPTIONS only).
ok((cors["Access-Control-Allow-Methods"] || "").includes("POST") &&
   (cors["Access-Control-Allow-Methods"] || "").includes("OPTIONS"),
   "Allow-Methods advertises POST + OPTIONS");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 && typeof (globalThis as { process?: { exit(n: number): void } }).process !== "undefined") {
  (globalThis as unknown as { process: { exit(n: number): void } }).process.exit(1);
}
