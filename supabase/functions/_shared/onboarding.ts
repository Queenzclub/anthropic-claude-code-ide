// Onboarding orchestration — pure/dependency-injected so it is unit-testable
// without Deno or a live Supabase. The HTTP handlers (index.ts) build the real
// clients and pass them in as `Deps`.
//
// Security-critical wiring (see plan corrections):
//   * `rpc` is the CALLER-scoped App Admin JWT client. EVERY onboarding RPC,
//     lifecycle change, profile link, onboarding-table mutation and audit
//     insert goes through it — so app.is_app_admin() authorizes each call.
//   * `authAdmin` is the SERVICE-ROLE client, used ONLY for Auth Admin API
//     operations — and ONLY inviteUserByEmail. There is deliberately NO
//     deleteUser: the workflow NEVER deletes an Auth user, because a link RPC
//     may have committed while its response was lost. A harmless unlinked
//     inactive Auth account is preferable to deleting a possibly-committed
//     administrator.
//   * `sendRecoveryEmail` uses the ANON/caller client's resetPasswordForEmail,
//     NOT the service-role client.
//
// RPC calls resolve with { data, error }. We NEVER silently ignore a returned
// error object: markers/recording are only tolerated after re-reading the
// authoritative onboarding status and confirming it is safe.

import {
  type NormalizedInput, SAFE_TO_LINK, toSafeError, UNSAFE_CLASSIFICATIONS,
} from "./validate.ts";

export interface RpcResult { data: any; error: { message?: string } | null }
export interface Deps {
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
  authAdmin: {
    inviteUserByEmail(email: string): Promise<{ userId?: string | null; alreadyExists?: boolean; error?: { message?: string } | null }>;
  };
  sendRecoveryEmail(email: string): Promise<{ error?: { message?: string } | null }>;
}

export type Outcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

const ORDER = ["requested", "company_created", "resolving_auth_user", "linking_profile", "admin_linked", "completed"];
function atOrPast(state: string, target: string): boolean {
  const s = ORDER.indexOf(state), t = ORDER.indexOf(target);
  return s >= 0 && t >= 0 && s >= t;
}

function ok(data: any, input: NormalizedInput, emailStatus?: string): Outcome {
  return {
    ok: true,
    result: {
      company_id: data.company_id,
      company_code: data.company_code ?? input.company_code,
      status: "active",
      admin_email: input.first_admin_email,
      setup_email_status: emailStatus ?? data.setup_email_status ?? "requested",
    },
  };
}

export async function runCreateCompany(deps: Deps, input: NormalizedInput): Promise<Outcome> {
  // 1) Reserve + create the company (idempotent).
  const begin = await deps.rpc("begin_company_onboarding", {
    p_idempotency_key: input.idempotency_key,
    p_company_name: input.company_name,
    p_company_code: input.company_code,
    p_timezone: input.timezone,
    p_admin_name: input.first_admin_name,
    p_admin_email: input.first_admin_email,
  });
  if (begin.error) return { ok: false, error: toSafeError(begin.error.message) };
  const ob: string = begin.data.onboarding_id;
  let state: string = begin.data.state;

  if (state === "completed") return ok(begin.data, input); // replay of a finished onboarding
  if (state === "failed_terminal") return { ok: false, error: toSafeError(begin.data.error_code) };

  const failOnboarding = async (code: string, terminal: boolean): Promise<Outcome> => {
    const r = await deps.rpc("fail_company_onboarding", { p_onboarding: ob, p_error_code: code, p_terminal: terminal });
    // Inspect the result: if recording the failure itself errored we cannot fix
    // it here, but we never pretend it succeeded — the caller still gets a
    // truthful error code.
    if (r.error) return { ok: false, error: terminal ? code : "retry_required" };
    return { ok: false, error: terminal ? code : "retry_required" };
  };

  // Resume a retriable attempt: move it back to resolving_auth_user first.
  if (state === "failed_retriable") {
    const rt = await deps.rpc("retry_company_onboarding", { p_onboarding: ob });
    if (rt.error) return { ok: false, error: toSafeError(rt.error.message) };
    state = rt.data.state;
  }

  // Forward marker; tolerate only an already-advanced state (verified by re-read).
  const advance = async (to: string): Promise<{ ok: boolean; error?: string }> => {
    const r = await deps.rpc("advance_company_onboarding_state", { p_onboarding: ob, p_to: to });
    if (!r.error) return { ok: true };
    const st = await deps.rpc("get_company_onboarding_status", { p_onboarding: ob });
    if (st.error) return { ok: false, error: toSafeError(st.error.message) };
    if (atOrPast(st.data.state, to)) return { ok: true };
    return { ok: false, error: toSafeError(r.error.message) };
  };

  // 2) Resolve the Auth user for the first admin.
  let adv = await advance("resolving_auth_user");
  if (!adv.ok) return failOnboarding(adv.error || "retry_required", false);

  const look = await deps.rpc("lookup_onboarding_email", { p_onboarding: ob });
  if (look.error) return failOnboarding(toSafeError(look.error.message), false);
  const cls: string = look.data.classification;

  let authUserId: string;
  let createdByUs = false;   // audit provenance only — never drives destructive behavior
  let via: "invite" | "recovery";

  if (UNSAFE_CLASSIFICATIONS.has(cls)) {
    return failOnboarding("email_already_linked", true);
  } else if (cls === "none") {
    const inv = await deps.authAdmin.inviteUserByEmail(input.first_admin_email);
    if (inv.error || (!inv.userId && !inv.alreadyExists)) {
      // Ambiguous invite outcome: re-derive ownership by EXACT email (bound to
      // the onboarding id). A user found only now is NOT ours; never delete.
      const re = await deps.rpc("lookup_onboarding_email", { p_onboarding: ob });
      if (re.error) return failOnboarding(toSafeError(re.error.message), false);
      const rcls: string = re.data.classification;
      if (rcls === "none") return failOnboarding("invitation_failed", false);       // retriable; company stays pending
      if (UNSAFE_CLASSIFICATIONS.has(rcls)) return failOnboarding("email_already_linked", true);
      authUserId = re.data.auth_user_id; createdByUs = false; via = "recovery";       // adopted / ownership-unknown
    } else if (inv.alreadyExists) {
      const re = await deps.rpc("lookup_onboarding_email", { p_onboarding: ob });
      if (re.error) return failOnboarding(toSafeError(re.error.message), false);
      if (UNSAFE_CLASSIFICATIONS.has(re.data.classification)) return failOnboarding("email_already_linked", true);
      authUserId = re.data.auth_user_id; createdByUs = false; via = "recovery";
    } else {
      authUserId = inv.userId as string; createdByUs = true; via = "invite";          // confirmed NEW user, invite email requested
    }
  } else if (SAFE_TO_LINK.has(cls)) {
    authUserId = look.data.auth_user_id; createdByUs = false; via = "recovery";        // adopt safe existing user
  } else {
    return failOnboarding("onboarding_failed", false);
  }

  // 3) Link the first Company Admin.
  adv = await advance("linking_profile");
  if (!adv.ok) return failOnboarding(adv.error || "retry_required", false);

  const link = await deps.rpc("link_first_company_admin", {
    p_onboarding: ob, p_auth_user_id: authUserId, p_created_by_us: createdByUs,
  });
  if (link.error) {
    const code = toSafeError(link.error.message);
    if (code === "email_already_linked") return failOnboarding("email_already_linked", true);
    // The link RPC may have COMMITTED while its response was lost/timed out.
    // Re-read the authoritative state before deciding — and NEVER delete.
    const st = await deps.rpc("get_company_onboarding_status", { p_onboarding: ob });
    const re = await deps.rpc("lookup_onboarding_email", { p_onboarding: ob });
    if (st.error || re.error) return failOnboarding("retry_required", false);         // cannot verify; preserve + retriable
    const linkedNow = st.data.state === "admin_linked" || st.data.state === "completed"
      || re.data.classification === "linked_this_company_admin";
    if (!linkedNow) return failOnboarding("retry_required", false);                    // user preserved as unlinked_inactive; retry adopts it
    // else: link actually succeeded — fall through and continue.
  }

  // 4) Setup email (non-fatal, separate from progression). invite() already
  //    requested the email; adopted/recovered users get a recovery/setup email.
  let emailStatus = "requested";
  if (via === "recovery") {
    const em = await deps.sendRecoveryEmail(input.first_admin_email);
    emailStatus = em && em.error ? "failed" : "requested";
  }
  const rec = await deps.rpc("record_admin_setup_email_result", {
    p_onboarding: ob, p_result_status: emailStatus,
    p_safe_error_code: emailStatus === "failed" ? "setup_email_failed" : null, p_is_retry: false,
  });
  if (rec.error) emailStatus = "uncertain";   // attempted but not recorded — reported honestly, never as success

  // 5) Activate (the RPC verifies the linked active admin before flipping status).
  const done = await deps.rpc("complete_company_onboarding", { p_onboarding: ob });
  if (done.error) return failOnboarding(toSafeError(done.error.message), false);

  return ok(done.data, input, emailStatus);
}

// Resend a password-setup email for an existing onboarding. Always uses the
// recovery email (never invite, never auth.resend), via the anon/caller client.
// The target RPCs reject any onboarding whose admin is not genuinely linked.
export async function runSendSetupEmail(deps: Deps, onboardingId: string): Promise<Outcome> {
  const tgt = await deps.rpc("get_onboarding_setup_target", { p_onboarding: onboardingId });
  if (tgt.error) return { ok: false, error: toSafeError(tgt.error.message) };
  const email: string = tgt.data.admin_email_normalized;

  const em = await deps.sendRecoveryEmail(email);
  const status = em && em.error ? "failed" : "requested";
  const rec = await deps.rpc("record_admin_setup_email_result", {
    p_onboarding: onboardingId, p_result_status: status,
    p_safe_error_code: status === "failed" ? "setup_email_failed" : null, p_is_retry: true,
  });
  if (rec.error) return { ok: false, error: toSafeError(rec.error.message) };   // do not falsely report recorded
  return { ok: true, result: { setup_email_status: status } };
}
