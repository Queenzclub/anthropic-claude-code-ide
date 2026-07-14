// Runtime-agnostic unit tests for the onboarding orchestration + validation.
// Drives runCreateCompany/runSendSetupEmail with FAKE clients, asserting every
// security-critical branch without a live Supabase. Runs under Deno
// (`deno test`) or Node (`node --experimental-strip-types onboarding_logic_test.ts`).

import { COMPANY_CODE_RE, toSafeError, validateInput } from "../_shared/validate.ts";
import { type Deps, runCreateCompany, runSendSetupEmail } from "../_shared/onboarding.ts";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) { console.log("PASS: " + msg); passed++; }
  else { console.log(`FAIL: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); failed++; }
}
function ok(cond: boolean, msg: string) { eq(!!cond, true, msg); }

interface FakeOpts {
  classify: string[];               // classification per successive lookup call
  authUserId?: string;
  invite?: { userId?: string | null; alreadyExists?: boolean; error?: any };
  beginState?: string;
  beginErrorCode?: string;
  linkError?: string | null;
  linkCommitted?: boolean;          // link returns error but the RPC actually committed (lost response)
  completeError?: string | null;
  recoveryError?: any;
  recordError?: boolean;            // record_admin_setup_email_result resolves with an error object
  failError?: boolean;              // fail_company_onboarding resolves with an error object
  advanceError?: boolean;           // advance resolves with an error object (not idempotent)
  statusEmail?: string;             // get_onboarding_setup_target email
}
function makeDeps(o: FakeOpts) {
  const calls: any = { rpc: [] as string[], invited: 0, recovery: [] as string[] };
  let cur = o.beginState ?? "company_created";
  let lookIdx = 0;
  const rpc = (fn: string, args: any): Promise<{ data: any; error: any }> => {
    calls.rpc.push(fn);
    switch (fn) {
      case "begin_company_onboarding":
        return Promise.resolve({ data: { onboarding_id: "ob1", company_id: "co1", company_code: "CODE", state: cur, error_code: o.beginErrorCode ?? null }, error: null });
      case "retry_company_onboarding":
        cur = "resolving_auth_user";
        return Promise.resolve({ data: { state: cur }, error: null });
      case "advance_company_onboarding_state":
        if (o.advanceError) return Promise.resolve({ data: null, error: { message: "boom" } });
        cur = args.p_to;
        return Promise.resolve({ data: { state: cur }, error: null });
      case "lookup_onboarding_email": {
        const c = o.classify[Math.min(lookIdx, o.classify.length - 1)] ?? "none"; lookIdx++;
        return Promise.resolve({ data: { auth_user_id: c === "none" ? null : (o.authUserId ?? "u1"), classification: c }, error: null });
      }
      case "link_first_company_admin":
        if (o.linkError) { if (o.linkCommitted) cur = "admin_linked"; return Promise.resolve({ data: null, error: { message: o.linkError } }); }
        cur = "admin_linked";
        return Promise.resolve({ data: { onboarding_id: "ob1", state: "admin_linked", setup_email_status: "not_attempted" }, error: null });
      case "get_company_onboarding_status":
        return Promise.resolve({ data: { state: cur, error_code: o.beginErrorCode ?? null }, error: null });
      case "complete_company_onboarding":
        if (o.completeError) return Promise.resolve({ data: null, error: { message: o.completeError } });
        cur = "completed";
        return Promise.resolve({ data: { company_id: "co1", company_code: "CODE", state: "completed" }, error: null });
      case "record_admin_setup_email_result":
        return Promise.resolve(o.recordError ? { data: null, error: { message: "admin_not_linked" } } : { data: {}, error: null });
      case "fail_company_onboarding":
        return Promise.resolve(o.failError ? { data: null, error: { message: "boom" } } : { data: {}, error: null });
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
  eq(toSafeError("admin_not_linked"), "admin_not_linked", "admin_not_linked is a safe code");

  const V = validateInput(INPUT); if (!V.ok) throw new Error("input");

  // structural: no deleteUser anywhere in the dependency surface
  {
    const { deps } = makeDeps({ classify: ["none"] });
    ok(!("deleteUser" in (deps.authAdmin as any)), "STRUCT authAdmin has no deleteUser (no deletion path exists)");
  }

  // T1 happy new-user via invite; invite emails (no recovery send)
  {
    const { deps, calls } = makeDeps({ classify: ["none"], invite: { userId: "newuser" } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.status === "active", "T1 new-user onboarding activates");
    ok(calls.invited === 1 && calls.recovery.length === 0, "T1 invite once, no recovery email");
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
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "email_already_linked" }, "T3 unsafe -> email_already_linked");
    ok(calls.invited === 0 && calls.recovery.length === 0 && calls.rpc.includes("fail_company_onboarding"), "T3 no invite/recovery; failure recorded");
  }

  // T4 ambiguous invite error, re-lookup finds SAFE user -> adopt; NEVER delete
  {
    const { deps, calls } = makeDeps({ classify: ["none", "unlinked_inactive"], authUserId: "raced", invite: { error: { message: "timeout" } } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T4 ambiguous-invite then adopt succeeds");
    ok(calls.recovery.length === 1, "T4 adopted user gets recovery email (no deletion possible)");
  }

  // T5 ambiguous invite error, re-lookup finds NO user -> retriable, no activation
  {
    const { deps, calls } = makeDeps({ classify: ["none", "none"], invite: { error: { message: "smtp down" } } });
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "retry_required" }, "T5 ambiguous-invite no-user -> retry_required");
    ok(!calls.rpc.includes("complete_company_onboarding"), "T5 no activation");
  }

  // T6 ambiguous invite error, re-lookup finds UNSAFE user -> email_already_linked
  {
    const { deps } = makeDeps({ classify: ["none", "is_app_admin"], invite: { error: { message: "x" } } });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "email_already_linked" }, "T6 ambiguous-invite unsafe -> email_already_linked");
  }

  // T7 link RPC COMMITTED but response lost (state now admin_linked) -> continue, activate, NO deletion
  {
    const { deps, calls } = makeDeps({ classify: ["none", "linked_this_company_admin"], invite: { userId: "brandnew" }, linkError: "network", linkCommitted: true });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.status === "active", "T7 lost-response link -> still completes (no deletion)");
    ok(calls.rpc.includes("complete_company_onboarding"), "T7 proceeds to activation");
  }

  // T8 link network error while DB state is admin_linked (via status) -> continue
  {
    const { deps } = makeDeps({ classify: ["none", "unlinked_inactive"], invite: { userId: "b" }, linkError: "ECONNRESET", linkCommitted: true });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T8 network error but committed -> success");
  }

  // T9 link DEFINITELY fails before linking (state stays, classification unlinked) -> failed_retriable, preserved, no deletion
  {
    const { deps, calls } = makeDeps({ classify: ["none", "unlinked_inactive"], invite: { userId: "b" }, linkError: "invalid_input", linkCommitted: false });
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "retry_required" }, "T9 definite link failure -> retry_required");
    ok(calls.rpc.includes("fail_company_onboarding") && !calls.rpc.includes("complete_company_onboarding"), "T9 records failure, no activation");
  }

  // T10 retry adopts the PRESERVED unlinked-inactive user (begin resumes failed_retriable)
  {
    const { deps, calls } = makeDeps({ beginState: "failed_retriable", classify: ["unlinked_inactive"], authUserId: "preserved" });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T10 retry resumes + completes");
    ok(calls.rpc.includes("retry_company_onboarding"), "T10 moves failed_retriable -> resolving");
    ok(calls.invited === 0 && calls.recovery.length === 1, "T10 retry ADOPTS preserved user (no new invite), sends recovery");
  }

  // T11 failed_terminal replay -> returns the recorded terminal error, no work
  {
    const { deps, calls } = makeDeps({ beginState: "failed_terminal", beginErrorCode: "email_already_linked", classify: ["none"] });
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "email_already_linked" }, "T11 failed_terminal replay -> recorded error");
    ok(calls.invited === 0 && !calls.rpc.includes("link_first_company_admin"), "T11 does no auth/link work");
  }

  // T12 completed replay -> success, no work
  {
    const { deps, calls } = makeDeps({ beginState: "completed", classify: ["none"] });
    ok((await runCreateCompany(deps, V.value)).ok, "T12 completed replay -> success");
    ok(calls.invited === 0 && !calls.rpc.includes("link_first_company_admin"), "T12 no auth/link work");
  }

  // T13 recovery email FAILS on adopt -> still activates; status=failed
  {
    const { deps } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "e", recoveryError: { message: "smtp" } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.setup_email_status === "failed", "T13 email failure does NOT block activation (status=failed)");
  }

  // T14 record_admin_setup_email_result RESOLVES WITH AN ERROR -> emailStatus 'uncertain', still activates, not silently ignored
  {
    const { deps } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "e", recordError: true });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.setup_email_status === "uncertain", "T14 record error -> setup_email_status=uncertain (handled, not ignored)");
  }

  // T15 advance RESOLVES WITH AN ERROR and state is NOT past target -> failed_retriable
  {
    const { deps, calls } = makeDeps({ classify: ["none"], advanceError: true });
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "retry_required" }, "T15 non-idempotent advance error -> retry_required");
    ok(calls.rpc.includes("fail_company_onboarding"), "T15 records the failure");
  }

  // T16 begin conflict -> passthrough, no auth work
  {
    const deps: Deps = {
      rpc: (fn) => Promise.resolve(fn === "begin_company_onboarding" ? { data: null, error: { message: "idempotency_conflict" } } : { data: {}, error: null }),
      authAdmin: { inviteUserByEmail: () => { throw new Error("should not invite"); } },
      sendRecoveryEmail: () => { throw new Error("should not email"); },
    };
    eq(await runCreateCompany(deps, V.value), { ok: false, error: "idempotency_conflict" }, "T16 begin conflict short-circuits");
  }

  // T17 resend: recovery + is_retry, email derived server-side, never invites
  {
    const { deps, calls } = makeDeps({ classify: [] });
    const r = await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111");
    ok(r.ok && calls.invited === 0 && calls.recovery.length === 1 && calls.recovery[0] === "target@x.co", "T17 resend derives email server-side + recovery, no invite");
    ok(calls.rpc.includes("get_onboarding_setup_target") && calls.rpc.includes("record_admin_setup_email_result"), "T17 records result");
  }

  // T18 resend when target RPC rejects (admin not linked) -> error surfaced, no email
  {
    const deps: Deps = {
      rpc: (fn) => Promise.resolve(fn === "get_onboarding_setup_target" ? { data: null, error: { message: "admin_not_linked" } } : { data: {}, error: null }),
      authAdmin: { inviteUserByEmail: () => { throw new Error("no invite"); } },
      sendRecoveryEmail: () => { throw new Error("no email before target check"); },
    };
    eq(await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111"), { ok: false, error: "admin_not_linked" }, "T18 resend gated: admin_not_linked surfaced, no email sent");
  }

  // T19 resend record error -> not falsely reported as recorded
  {
    const { deps } = makeDeps({ classify: [], recordError: true });
    eq(await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111"), { ok: false, error: "admin_not_linked" }, "T19 resend record error surfaced (no false success)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  const g = globalThis as any;
  if (failed > 0 && g.process?.exit) g.process.exit(1);
}

main();
