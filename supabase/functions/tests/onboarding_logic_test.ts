// Runtime-agnostic unit tests for the onboarding orchestration + validation.
// Uses only a tiny built-in runner + `assert`, so it runs under Deno
// (`deno test`) OR Node (`node --experimental-strip-types --test` is not needed;
// just `node --experimental-strip-types onboarding_logic_test.ts`). It drives
// runCreateCompany/runSendSetupEmail with FAKE clients, asserting every
// security-critical branch without a live Supabase.

import { COMPANY_CODE_RE, toSafeError, validateInput } from "../_shared/validate.ts";
import { type Deps, runCreateCompany, runSendSetupEmail } from "../_shared/onboarding.ts";

// ---- tiny runner ----
let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) { console.log("PASS: " + msg); passed++; }
  else { console.log(`FAIL: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); failed++; }
}
function ok(cond: boolean, msg: string) { eq(!!cond, true, msg); }

// ---- fake client builder ----
type RpcHandler = (args: any) => { data?: any; error?: any };
interface FakeOpts {
  classify: string[];                 // classification returned by successive lookup calls
  authUserId?: string;
  invite?: { userId?: string | null; alreadyExists?: boolean; error?: any };
  linkError?: string | null;
  completeError?: string | null;
  beginState?: string;
  recoveryError?: any;
}
function makeDeps(o: FakeOpts) {
  const calls: any = { rpc: [] as string[], invited: 0, deleted: [] as string[], recovery: [] as string[] };
  let lookIdx = 0;
  const rpc = (fn: string, args: any) => {
    calls.rpc.push(fn);
    switch (fn) {
      case "begin_company_onboarding":
        return Promise.resolve({ data: { onboarding_id: "ob1", company_id: "co1", company_code: "CODE", state: o.beginState ?? "company_created" }, error: null });
      case "lookup_onboarding_email": {
        const c = o.classify[Math.min(lookIdx, o.classify.length - 1)]; lookIdx++;
        return Promise.resolve({ data: { auth_user_id: c === "none" ? null : (o.authUserId ?? "u1"), classification: c }, error: null });
      }
      case "link_first_company_admin":
        return Promise.resolve(o.linkError ? { data: null, error: { message: o.linkError } } : { data: { onboarding_id: "ob1", state: "admin_linked", setup_email_status: "not_attempted" }, error: null });
      case "complete_company_onboarding":
        return Promise.resolve(o.completeError ? { data: null, error: { message: o.completeError } } : { data: { company_id: "co1", company_code: "CODE", state: "completed" }, error: null });
      case "get_onboarding_setup_target":
        return Promise.resolve({ data: { admin_email_normalized: "target@x.co" }, error: null });
      case "advance_company_onboarding_state":
      case "fail_company_onboarding":
      case "record_admin_setup_email_result":
        return Promise.resolve({ data: {}, error: null });
      default:
        return Promise.resolve({ data: {}, error: null });
    }
  };
  const deps: Deps = {
    rpc,
    authAdmin: {
      inviteUserByEmail: (_email) => { calls.invited++; return Promise.resolve(o.invite ?? { userId: "newuser" }); },
      deleteUser: (id) => { calls.deleted.push(id); return Promise.resolve({ error: null }); },
    },
    sendRecoveryEmail: (email) => { calls.recovery.push(email); return Promise.resolve({ error: o.recoveryError ?? null }); },
  };
  return { deps, calls };
}

const INPUT = { company_name: "Co", company_code: "NEWCODE", timezone: "UTC", first_admin_name: "A", first_admin_email: "a@x.co", idempotency_key: "11111111-1111-1111-1111-111111111111" };

async function main() {
  // ---- validation ----
  ok(COMPANY_CODE_RE.test("AB-12"), "code regex accepts AB-12");
  ok(!COMPANY_CODE_RE.test("ab"), "code regex rejects too-short/lowercase");
  eq(validateInput({ ...INPUT, company_code: "ok" }).ok, false, "validateInput rejects bad code");
  eq(validateInput({ ...INPUT, first_admin_email: "no-at" }).ok, false, "validateInput rejects bad email");
  eq(validateInput({ ...INPUT, idempotency_key: "not-a-uuid" }).ok, false, "validateInput rejects bad idempotency key");
  const good = validateInput(INPUT);
  ok(good.ok && good.value.company_code === "NEWCODE", "validateInput normalizes/accepts");

  // ---- error redaction ----
  eq(toSafeError("company_code_exists"), "company_code_exists", "safe code passes through");
  eq(toSafeError('duplicate key value violates unique constraint "x"'), "onboarding_failed", "raw PG error redacted");
  eq(toSafeError("permission denied for function foo"), "not_allowed", "permission denied -> not_allowed");

  const V = validateInput(INPUT); if (!V.ok) throw new Error("input");

  // T1: happy path, brand-new user via invite; invite email already requested (no recovery send)
  {
    const { deps, calls } = makeDeps({ classify: ["none"], invite: { userId: "newuser" } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T1 new-user onboarding succeeds");
    ok(calls.invited === 1, "T1 invited exactly once");
    ok(calls.recovery.length === 0, "T1 invite path sends NO recovery email");
    ok(calls.rpc.includes("link_first_company_admin") && calls.rpc.includes("complete_company_onboarding"), "T1 links + completes");
    ok(calls.rpc.filter((f: string) => f === "link_first_company_admin").length === 1, "T1 links once");
    ok(r.ok && r.result.status === "active", "T1 returns active");
  }

  // T2: adopt safe existing unlinked user -> recovery email (NOT invite)
  {
    const { deps, calls } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "existing" });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T2 adopt onboarding succeeds");
    ok(calls.invited === 0, "T2 adopt path does NOT invite");
    ok(calls.recovery.length === 1, "T2 adopt path sends a recovery email");
  }

  // T3: unsafe existing (linked to another company) -> email_already_linked, no invite
  {
    const { deps, calls } = makeDeps({ classify: ["linked_other_company"] });
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "email_already_linked" }, "T3 unsafe email -> email_already_linked");
    ok(calls.invited === 0 && calls.recovery.length === 0, "T3 no invite/recovery on unsafe");
    ok(calls.rpc.includes("fail_company_onboarding"), "T3 records failure");
  }

  // T4: ambiguous invite error, re-lookup finds a SAFE user -> adopt, created_by_us=false, never delete
  {
    const { deps, calls } = makeDeps({ classify: ["none", "unlinked_inactive"], authUserId: "raced", invite: { error: { message: "timeout" } } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T4 ambiguous-invite then adopt succeeds");
    ok(calls.deleted.length === 0, "T4 discovered user is NEVER deleted (ownership unknown)");
    ok(calls.recovery.length === 1, "T4 adopted user gets a recovery email");
  }

  // T5: ambiguous invite error, re-lookup finds NO user -> retriable, company stays pending
  {
    const { deps, calls } = makeDeps({ classify: ["none", "none"], invite: { error: { message: "smtp down" } } });
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "retry_required" }, "T5 ambiguous-invite no-user -> retry_required");
    ok(calls.deleted.length === 0, "T5 nothing deleted");
    ok(!calls.rpc.includes("complete_company_onboarding"), "T5 no activation");
  }

  // T6: ambiguous invite error, re-lookup finds an UNSAFE user -> email_already_linked
  {
    const { deps } = makeDeps({ classify: ["none", "is_app_admin"], invite: { error: { message: "x" } } });
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "email_already_linked" }, "T6 ambiguous-invite unsafe -> email_already_linked");
  }

  // T7: link fails for a confidently-created user -> compensation deletes ONLY that user
  {
    const { deps, calls } = makeDeps({ classify: ["none"], invite: { userId: "brandnew" }, linkError: "invalid_input" });
    const r = await runCreateCompany(deps, V.value);
    ok(!r.ok, "T7 link failure surfaces an error");
    ok(calls.deleted.length === 1 && calls.deleted[0] === "brandnew", "T7 compensates by deleting the user we created");
  }

  // T8: link fails for an ADOPTED user -> never delete
  {
    const { deps, calls } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "existing", linkError: "invalid_input" });
    const r = await runCreateCompany(deps, V.value);
    ok(!r.ok, "T8 adopted link failure surfaces an error");
    ok(calls.deleted.length === 0, "T8 adopted user never deleted");
  }

  // T9: recovery email FAILS on adopt -> still activates (email separate from progression)
  {
    const { deps, calls } = makeDeps({ classify: ["unlinked_inactive"], authUserId: "existing", recoveryError: { message: "smtp" } });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok && r.result.status === "active", "T9 email failure does NOT block activation");
    eq(r.ok && r.result.setup_email_status, "failed", "T9 reports setup_email_status=failed");
    ok(calls.rpc.includes("complete_company_onboarding"), "T9 still completes");
  }

  // T10: begin conflict -> passthrough safe code, no auth work
  {
    const deps: Deps = {
      rpc: (fn) => Promise.resolve(fn === "begin_company_onboarding" ? { data: null, error: { message: "idempotency_conflict" } } : { data: {}, error: null }),
      authAdmin: { inviteUserByEmail: () => { throw new Error("should not invite"); }, deleteUser: () => Promise.resolve({ error: null }) },
      sendRecoveryEmail: () => { throw new Error("should not email"); },
    };
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "idempotency_conflict" }, "T10 begin conflict short-circuits");
  }

  // T11: replay of a completed onboarding -> success, no auth/link work
  {
    const { deps, calls } = makeDeps({ classify: ["none"], beginState: "completed" });
    const r = await runCreateCompany(deps, V.value);
    ok(r.ok, "T11 completed replay returns success");
    ok(calls.invited === 0 && !calls.rpc.includes("link_first_company_admin"), "T11 does no auth/link work");
  }

  // T12: resend uses recovery + is_retry, derives email server-side, no invite
  {
    const { deps, calls } = makeDeps({ classify: [] });
    const r = await runSendSetupEmail(deps, "11111111-1111-1111-1111-111111111111");
    ok(r.ok, "T12 resend succeeds");
    ok(calls.invited === 0, "T12 resend never invites");
    ok(calls.recovery.length === 1 && calls.recovery[0] === "target@x.co", "T12 resend derives email server-side + sends recovery");
    ok(calls.rpc.includes("get_onboarding_setup_target") && calls.rpc.includes("record_admin_setup_email_result"), "T12 records the result");
  }

  // T13: DB finalization (complete) fails -> retry_required, never a false success
  {
    const { deps, calls } = makeDeps({ classify: ["none"], invite: { userId: "u" }, completeError: "retry_required" });
    const r = await runCreateCompany(deps, V.value);
    eq(r, { ok: false, error: "retry_required" }, "T13 complete failure -> retry_required");
    ok(calls.rpc.includes("fail_company_onboarding"), "T13 records the failure");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  const anyGlobal = globalThis as any;
  if (failed > 0 && anyGlobal.process?.exit) anyGlobal.process.exit(1);
}

main();
