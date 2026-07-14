// Runtime-agnostic unit tests for the onboarding orchestration + validation.
// Drives runCreateCompany/runSendSetupEmail with FAKE clients, asserting every
// security-critical branch without a live Supabase. Runs under Deno
// (`deno test`) or Node (`node --experimental-strip-types onboarding_logic_test.ts`).
//
// The fake ENFORCES the processing lease: every state-mutating RPC checks that
// the orchestrator passed the exact token it claimed, so a missing/wrong token
// anywhere in the flow fails these tests.

import { COMPANY_CODE_RE, readConfig, toSafeError, validateInput } from "../_shared/validate.ts";
import { type Deps, runCreateCompany, runSendSetupEmail } from "../_shared/onboarding.ts";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) { console.log("PASS: " + msg); passed++; }
  else { console.log(`FAIL: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); failed++; }
}
function ok(cond: boolean, msg: string) { eq(!!cond, true, msg); }
function throws(fn: () => unknown, needle: string, msg: string) {
  try { fn(); console.log(`FAIL: ${msg} — did not throw`); failed++; }
  catch (e) {
    const m = String((e as Error).message || e);
    if (m.includes(needle)) { console.log("PASS: " + msg); passed++; }
    else { console.log(`FAIL: ${msg} — threw ${m}`); failed++; }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FakeOpts {
  classify: string[];               // classification per successive lookup call
  authUserId?: string;
  invite?: { userId?: string | null; alreadyExists?: boolean; error?: any };
  beginState?: string;
  beginErrorCode?: string;
  claimError?: boolean;             // concurrent execution: claim rejected
  linkError?: string | null;
  linkCommitted?: boolean;          // link returns error but the RPC actually committed (lost response)
  completeError?: string | null;
  recoveryError?: any;
  recordError?: boolean;            // record_admin_setup_email_result resolves with an error object
  advanceError?: boolean;           // advance resolves with an error object (not idempotent)
  statusEmail?: string;             // get_onboarding_setup_target email
}
function makeDeps(o: FakeOpts) {
  const calls: any = { rpc: [] as string[], invited: 0, recovery: [] as string[], claims: [] as string[], releases: 0 };
  let cur = o.beginState ?? "company_created";
  let lease: string | null = null;
  let lookIdx = 0;
  const owned = (args: any) => lease !== null && args.p_processing_token === lease;
  const rpc = (fn: string, args: any): Promise<{ data: any; error: any }> => {
    calls.rpc.push(fn);
    switch (fn) {
      case "begin_company_onboarding":
        return Promise.resolve({ data: { onboarding_id: "ob1", company_id: "co1", company_code: "CODE", state: cur, error_code: o.beginErrorCode ?? null }, error: null });
      case "claim_company_onboarding_processing":
        if (o.claimError) return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
        lease = args.p_processing_token; calls.claims.push(lease as string);
        return Promise.resolve({ data: { state: cur }, error: null });
      case "release_company_onboarding_processing":
        if (owned(args)) { lease = null; calls.releases++; return Promise.resolve({ data: {}, error: null }); }
        return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
      case "retry_company_onboarding":
        if (!owned(args)) return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
        cur = "resolving_auth_user";
        return Promise.resolve({ data: { state: cur }, error: null });
      case "advance_company_onboarding_state":
        if (!owned(args)) return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
        if (o.advanceError) return Promise.resolve({ data: null, error: { message: "boom" } });
        cur = args.p_to;
        return Promise.resolve({ data: { state: cur }, error: null });
      case "lookup_onboarding_email": {
        const c = o.classify[Math.min(lookIdx, o.classify.length - 1)] ?? "none"; lookIdx++;
        return Promise.resolve({ data: { auth_user_id: c === "none" ? null : (o.authUserId ?? "u1"), classification: c }, error: null });
      }
      case "link_first_company_admin":
        if (!owned(args)) return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
        if (o.linkError) { if (o.linkCommitted) cur = "admin_linked"; return Promise.resolve({ data: null, error: { message: o.linkError } }); }
        cur = "admin_linked";
        return Promise.resolve({ data: { onboarding_id: "ob1", state: "admin_linked", setup_email_status: "not_attempted" }, error: null });
      case "get_company_onboarding_status":
        return Promise.resolve({ data: { state: cur, error_code: o.beginErrorCode ?? null }, error: null });
      case "complete_company_onboarding":
        if (!owned(args)) return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
        if (o.completeError) return Promise.resolve({ data: null, error: { message: o.completeError } });
        cur = "completed"; lease = null;   // auto-release on success
        return Promise.resolve({ data: { company_id: "co1", company_code: "CODE", state: "completed" }, error: null });
      case "record_admin_setup_email_result":
        if (!owned(args)) return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
        return Promise.resolve(o.recordError ? { data: null, error: { message: "admin_not_linked" } } : { data: {}, error: null });
      case "fail_company_onboarding":
        if (!owned(args)) return Promise.resolve({ data: null, error: { message: "onboarding_in_progress" } });
        cur = args.p_terminal ? "failed_terminal" : "failed_retriable"; lease = null;   // auto-release
        return Promise.resolve({ data: {}, error: null });
      case "get_onboarding_setup_target":
        return Promise.resolve({ data: { admin_email_normalized: o.statusEmail ?? "target@x.co" }, error: null });
      default:
        return Promise.resolve({ data: {}, error: null });
    }
  };
  const deps: Deps = {
    rpc,
    authAdmin: { inviteUserByEmail: (_e) => { calls.invited++; return Promise.resolve(o.invite ?? { userId: "newuser" }); } },
    sendRecoveryEmail: (email) => { calls.recovery.push(email); return Promise.resolve({ error: o.recoveryError ?? null }); },
  };
  return { deps, calls };
}

const INPUT = { company_name: "Co", company_code: "NEWCODE", timezone: "UTC", first_admin_name: "A", first_admin_email: "a@x.co", idempotency_key: "11111111-1111-1111-1111-111111111111" };
const PROD_SET_PASSWORD = "https://queenzclub.github.io/anthropic-claude-code-ide/set-password.html";

async function main() {
  // ---- validation + redaction ----
  ok(COMPANY_CODE_RE.test("AB-12"), "code regex accepts AB-12");
  ok(!COMPANY_CODE_RE.test("ab"), "code regex rejects too-short/lowercase");
  eq(validateInput({ ...INPUT, company_code: "ok" }).ok, false, "validateInput rejects bad code");
  eq(validateInput({ ...INPUT, first_admin_email: "no-at" }).ok, false, "validateInput rejects bad email");
  eq(validateInput({ ...INPUT, idempotency_key: "nope" }).ok, false, "validateInput rejects bad idempotency key");
  ok(validateInput(INPUT).ok, "validateInput accepts a good payload");
  eq(toSafeError("company_code_exists"), "company_code_exists", "safe code passes through");
  eq(toSafeError('duplicate key value violates unique constraint "x"'), "onboarding_failed", "raw PG error redacted");
  eq(toSafeError("permission denied for function foo"), "not_allowed", "permission denied -> not_allowed");
  eq(toSafeError("onboarding_in_progress"), "onboarding_in_progress", "onboarding_in_progress is a safe code");

  // ---- configuration (SET_PASSWORD_URL) ----
  throws(() => readConfig({ ALLOWED_ORIGIN: "https://queenzclub.github.io" }),
    "SET_PASSWORD_URL is required", "CFG1 missing SET_PASSWORD_URL fails even with ALLOWED_ORIGIN set (no fallback)");
  throws(() => readConfig({ SET_PASSWORD_URL: PROD_SET_PASSWORD }),
    "ALLOWED_ORIGIN is required", "CFG2 missing ALLOWED_ORIGIN fails");
  throws(() => readConfig({ ALLOWED_ORIGIN: "https://queenzclub.github.io", SET_PASSWORD_URL: "not a url" }),
    "not a valid URL", "CFG3 invalid SET_PASSWORD_URL fails");
  throws(() => readConfig({ ALLOWED_ORIGIN: "https://queenzclub.github.io", SET_PASSWORD_URL: "http://example.com/set-password.html" }),
    "must be https", "CFG4 http rejected outside local development");
  {
    const c = readConfig({ ALLOWED_ORIGIN: "https://queenzclub.github.io", SET_PASSWORD_URL: PROD_SET_PASSWORD });
    ok(c.setPasswordUrl === PROD_SET_PASSWORD && c.setPasswordUrl.includes("/anthropic-claude-code-ide/set-password.html"),
      "CFG5 production redirect includes the GitHub Pages repository path");
    ok(c.setPasswordUrl !== c.allowedOrigin + "/set-password.html",
      "CFG6 redirect is NOT the origin-only fallback");
  }
  {
    const c = readConfig({ ALLOWED_ORIGIN: "http://localhost:8000", SET_PASSWORD_URL: "http://localhost:8000/set-password.html" });
    ok(c.setPasswordUrl.startsWith("http://localhost"), "CFG7 localhost http accepted for development");
  }
  // Request payload cannot smuggle a redirect or processing token: the
  // normalized input carries exactly the six approved fields.
  {
    const v = validateInput({ ...INPUT, set_password_url: "https://evil.example", processing_token: "x" } as any);
    ok(v.ok && Object.keys(v.value).sort().join(",") ===
      "company_code,company_name,first_admin_email,first_admin_name,idempotency_key,timezone",
      "CFG8 payload cannot override the redirect or supply a processing token");
  }

  const V = validateInput(INPUT); if (!V.ok) throw new Error("input");

  // structural: invite is the ONLY Auth Admin capability (no removal path)
  {
    const { deps } = makeDeps({ classify: ["none"] });
    eq(Object.keys(deps.authAdmin), ["inviteUserByEmail"], "STRUCT Auth Admin surface is exactly inviteUserByEmail");
  }

  // T1 happy new-user via invite; claims once; all mutating calls carry the token
  {
    const { deps, calls } = makeDeps({ classify: ["none"], invite: { userId: "newuser" } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.status === "active", "T1 new-user onboarding activates");
    ok(calls.invited === 1 && calls.recovery.length === 0, "T1 invite once, no recovery email");
    ok(calls.claims.length === 1 && UUID_RE.test(calls.claims[0]), "T1 lease claimed exactly once with a server-side uuid");
    // The fake rejects any mutating call without the claimed token, so reaching
    // 'active' proves link/record/complete all carried it.
  }

  // T2 adopt safe existing unlinked user -> recovery email (not invite)
  {
    const { deps, calls } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "existing" });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T2 adopt succeeds");
    ok(calls.invited === 0 && calls.recovery.length === 1, "T2 adopt: no invite, one recovery email");
  }

  // T3 unsafe existing -> email_already_linked, no invite/recovery, failure recorded
  {
    const { deps, calls } = makeDeps({ classify: ["linked_other_company"] });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "email_already_linked" }, "T3 unsafe -> email_already_linked");
    ok(calls.invited === 0 && calls.recovery.length === 0 && calls.rpc.includes("fail_company_onboarding"), "T3 no invite/recovery; failure recorded");
  }

  // T4 ambiguous invite error, re-lookup finds SAFE user -> adopt (preserved, never removed)
  {
    const { deps, calls } = makeDeps({ classify: ["none", "unlinked_inactive"], authUserId: "raced", invite: { error: { message: "timeout" } } });
    ok((await runCreateCompany(deps, V.value)).ok, "T4 ambiguous-invite then adopt succeeds");
    ok(calls.recovery.length === 1, "T4 adopted user gets recovery email");
  }

  // T5 ambiguous invite error, re-lookup finds NO user -> retriable, no activation
  {
    const { deps, calls } = makeDeps({ classify: ["none", "none"], invite: { error: { message: "smtp down" } } });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "retry_required" }, "T5 ambiguous-invite no-user -> retry_required");
    ok(!calls.rpc.includes("complete_company_onboarding"), "T5 no activation");
  }

  // T6 ambiguous invite error, re-lookup finds UNSAFE user -> email_already_linked
  {
    const { deps } = makeDeps({ classify: ["none", "is_app_admin"], invite: { error: { message: "x" } } });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "email_already_linked" }, "T6 ambiguous-invite unsafe -> email_already_linked");
  }

  // T7 link RPC COMMITTED but response lost -> continue, activate, user preserved
  {
    const { deps, calls } = makeDeps({ classify: ["none", "linked_this_company_admin"], invite: { userId: "brandnew" }, linkError: "network", linkCommitted: true });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.status === "active", "T7 lost-response link -> still completes");
    ok(calls.rpc.includes("complete_company_onboarding"), "T7 proceeds to activation");
  }

  // T8 link network error while DB state is admin_linked (via status) -> continue
  {
    const { deps } = makeDeps({ classify: ["none", "unlinked_inactive"], invite: { userId: "b" }, linkError: "ECONNRESET", linkCommitted: true });
    ok((await runCreateCompany(deps, V.value)).ok, "T8 network error but committed -> success");
  }

  // T9 link DEFINITELY fails before linking -> failed_retriable, user preserved
  {
    const { deps, calls } = makeDeps({ classify: ["none", "unlinked_inactive"], invite: { userId: "b" }, linkError: "invalid_input", linkCommitted: false });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "retry_required" }, "T9 definite link failure -> retry_required");
    ok(calls.rpc.includes("fail_company_onboarding") && !calls.rpc.includes("complete_company_onboarding"), "T9 records failure, no activation");
  }

  // T10 retry claims a fresh lease and adopts the PRESERVED unlinked-inactive user
  {
    const { deps, calls } = makeDeps({ beginState: "failed_retriable", classify: ["unlinked_inactive"], authUserId: "preserved" });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T10 retry resumes + completes");
    ok(calls.claims.length === 1 && calls.rpc.includes("retry_company_onboarding"), "T10 claims then retries");
    ok(calls.invited === 0 && calls.recovery.length === 1, "T10 retry ADOPTS preserved user (no new invite), sends recovery");
  }

  // T11 failed_terminal replay -> recorded error, no claim, no work
  {
    const { deps, calls } = makeDeps({ beginState: "failed_terminal", beginErrorCode: "email_already_linked", classify: ["none"] });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "email_already_linked" }, "T11 failed_terminal replay -> recorded error");
    ok(calls.claims.length === 0 && calls.invited === 0, "T11 no claim, no auth work");
  }

  // T12 completed replay -> success WITHOUT claiming; no Auth/email work
  {
    const { deps, calls } = makeDeps({ beginState: "completed", classify: ["none"] });
    ok((await runCreateCompany(deps, V.value)).ok, "T12 completed replay -> success");
    ok(calls.claims.length === 0 && calls.invited === 0 && calls.recovery.length === 0
      && !calls.rpc.includes("link_first_company_admin"), "T12 completed replay claims nothing, does no Auth/email work");
  }

  // T13 CONCURRENT execution: claim rejected -> onboarding_in_progress, zero side effects
  {
    const { deps, calls } = makeDeps({ classify: ["none"], claimError: true });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "onboarding_in_progress" }, "T13 second caller gets onboarding_in_progress");
    ok(calls.invited === 0 && calls.recovery.length === 0
      && !calls.rpc.includes("link_first_company_admin")
      && !calls.rpc.includes("complete_company_onboarding"), "T13 concurrent caller performs NO Auth/email/link work");
  }

  // T14 recovery email FAILS on adopt -> still activates; status=failed
  {
    const { deps } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "e", recoveryError: { message: "smtp" } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.setup_email_status === "failed", "T14 email failure does NOT block activation (status=failed)");
  }

  // T15 record error object -> 'uncertain', still activates (handled, not ignored)
  {
    const { deps } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "e", recordError: true });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.setup_email_status === "uncertain", "T15 record error -> setup_email_status=uncertain");
  }

  // T16 non-idempotent advance error -> failed_retriable
  {
    const { deps, calls } = makeDeps({ classify: ["none"], advanceError: true });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "retry_required" }, "T16 non-idempotent advance error -> retry_required");
    ok(calls.rpc.includes("fail_company_onboarding"), "T16 records the failure");
  }

  // T17 begin conflict -> passthrough, no claim/auth work
  {
    const deps: Deps = {
      rpc: (fn) => Promise.resolve(fn === "begin_company_onboarding" ? { data: null, error: { message: "idempotency_conflict" } } : { data: {}, error: null }),
      authAdmin: { inviteUserByEmail: () => { throw new Error("should not invite"); } },
      sendRecoveryEmail: () => { throw new Error("should not email"); },
    };
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "idempotency_conflict" }, "T17 begin conflict short-circuits");
  }

  // T18 resend: claims, recovery + is_retry, email derived server-side, releases
  {
    const { deps, calls } = makeDeps({ beginState: "completed", classify: [] });
    const r = await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111");
    ok(r.ok && calls.invited === 0 && calls.recovery.length === 1 && calls.recovery[0] === "target@x.co",
      "T18 resend derives email server-side + recovery, no invite");
    ok(calls.claims.length === 1 && calls.releases === 1, "T18 resend claims and releases the lease");
  }

  // T19 resend while another execution holds the lease -> onboarding_in_progress, no email
  {
    const { deps, calls } = makeDeps({ classify: [], claimError: true });
    eq(await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111"), { ok: false, error: "onboarding_in_progress" }, "T19 concurrent resend rejected");
    ok(calls.recovery.length === 0, "T19 no email sent by the losing caller");
  }

  // T20 resend when target RPC rejects (admin not linked) -> error surfaced, no email, lease released
  {
    const { deps, calls } = makeDeps({ classify: [], statusEmail: "x" });
    deps.rpc = ((orig) => (fn: string, args: any) =>
      fn === "get_onboarding_setup_target" ? Promise.resolve({ data: null, error: { message: "admin_not_linked" } }) : orig(fn, args)
    )(deps.rpc);
    eq(await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111"), { ok: false, error: "admin_not_linked" }, "T20 resend gated: admin_not_linked surfaced");
    ok(calls.recovery.length === 0 && calls.releases === 1, "T20 no email sent; lease released");
  }

  // T21 resend record error -> not falsely reported as recorded
  {
    const { deps } = makeDeps({ beginState: "admin_linked", classify: [], recordError: true });
    eq(await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111"), { ok: false, error: "admin_not_linked" }, "T21 resend record error surfaced (no false success)");
  }

  // T22 DB finalization (complete) fails -> retry_required, never a false success
  {
    const { deps, calls } = makeDeps({ classify: ["none"], invite: { userId: "u" }, completeError: "retry_required" });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "retry_required" }, "T22 complete failure -> retry_required");
    ok(calls.rpc.includes("fail_company_onboarding"), "T22 records the failure");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  const g = globalThis as any;
  if (failed > 0 && g.process?.exit) g.process.exit(1);
}

main();
