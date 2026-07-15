// Unit tests for complete-first-admin-setup's pure helpers. Runs under Deno
// (`deno test`) or node (`node --experimental-strip-types --test`).
import { mapFinalizeError, safeFinalizeResult } from "../_shared/finalize.ts";

let failed = 0;
function check(name: string, cond: boolean) {
  console.log((cond ? "PASS" : "FAIL") + ": " + name);
  if (!cond) failed++;
}

// Error mapping: only known-safe codes survive; everything else -> setup_failed.
check("not_allowed maps to 403", (() => { const m = mapFinalizeError("not_allowed"); return m.code === "not_allowed" && m.status === 403; })());
check("setup_proof_required maps to 401", (() => { const m = mapFinalizeError("setup_proof_required"); return m.code === "setup_proof_required" && m.status === 401; })());
check("unknown Postgres text is redacted to setup_failed/422", (() => { const m = mapFinalizeError("ERROR: relation \"x\" does not exist"); return m.code === "setup_failed" && m.status === 422; })());
check("null/undefined message -> setup_failed", (() => { const m = mapFinalizeError(undefined); return m.code === "setup_failed"; })());
check("no raw text leaks in mapped code", (() => { const m = mapFinalizeError("secret internal detail 12345"); return !/secret|12345/.test(m.code); })());

// Result shaping: safe fields only, no company_id leak.
check("first completion -> already_completed false", (() => { const r = safeFinalizeResult({ finalized: true, company_id: "c", already_completed: false }); return r.finalized === true && r.already_completed === false && !("company_id" in r); })());
check("idempotent replay -> already_completed true", (() => { const r = safeFinalizeResult({ finalized: true, company_id: "c", already_completed: true }); return r.already_completed === true && !("company_id" in r); })());
check("company_id is never echoed back", (() => { const r = safeFinalizeResult({ company_id: "leak-me", already_completed: true }); return !("company_id" in r) && JSON.stringify(r).indexOf("leak-me") === -1; })());
check("garbage rpc data -> safe default", (() => { const r = safeFinalizeResult(null); return r.finalized === true && r.already_completed === false; })());

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
if (failed > 0 && typeof (globalThis as { process?: { exit(n: number): void } }).process !== "undefined") {
  (globalThis as unknown as { process: { exit(n: number): void } }).process.exit(1);
}
