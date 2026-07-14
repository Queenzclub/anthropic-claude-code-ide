// Onboarding orchestration — pure/dependency-injected so it is unit-testable
// without Deno or a live Supabase. The HTTP handlers (index.ts) build the real
// clients and pass them in as `Deps`.
//
// Security-critical wiring (see plan corrections):
//   * `rpc` is the CALLER-scoped App Admin JWT client. EVERY onboarding RPC,
//     lifecycle change, profile link, onboarding-table mutation and audit
//     insert goes through it — so app.is_app_admin() authorizes each call.
//   * `authAdmin` is the SERVICE-ROLE client, used ONLY for Auth Admin API
//     operations (invite / delete user). It never touches the onboarding
//     tables or audit.
//   * `sendRecoveryEmail` uses the ANON/caller client's resetPasswordForEmail,
//     NOT the service-role client.

import {
  type NormalizedInput, SAFE_TO_LINK, toSafeError, UNSAFE_CLASSIFICATIONS,
} from "./validate.ts";

export interface RpcResult { data: any; error: { message?: string } | null }
export interface Deps {
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
  authAdmin: {
    inviteUserByEmail(email: string): Promise<{ userId?: string | null; alreadyExists?: boolean; error?: { message?: string } | null }>;
    deleteUser(id: string): Promise<{ error?: { message?: string } | null }>;
  };
  sendRecoveryEmail(email: string): Promise<{ error?: { message?: string } | null }>;
}

export type Outcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

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

async function safeAdvance(deps: Deps, ob: string, to: string): Promise<void> {
  // Forward marker only; ignore "already past" transitions.
  try { await deps.rpc("advance_company_onboarding_state", { p_onboarding: ob, p_to: to }); } catch (_) { /* ignore */ }
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
  if (begin.data.state === "completed") return ok(begin.data, input); // replay of a finished onboarding

  const failOnboarding = async (code: string, terminal: boolean): Promise<Outcome> => {
    try { await deps.rpc("fail_company_onboarding", { p_onboarding: ob, p_error_code: code, p_terminal: terminal }); } catch (_) { /* ignore */ }
    return { ok: false, error: terminal ? code : "retry_required" };
  };

  // 2) Resolve the Auth user for the first admin.
  await safeAdvance(deps, ob, "resolving_auth_user");
  const look = await deps.rpc("lookup_onboarding_email", { p_onboarding: ob });
  if (look.error) return failOnboarding(toSafeError(look.error.message), false);
  const cls: string = look.data.classification;

  let authUserId: string;
  let createdByUs = false;
  let via: "invite" | "recovery";

  if (UNSAFE_CLASSIFICATIONS.has(cls)) {
    return failOnboarding("email_already_linked", true);
  } else if (cls === "none") {
    const inv = await deps.authAdmin.inviteUserByEmail(input.first_admin_email);
    if (inv.error || (!inv.userId && !inv.alreadyExists)) {
      // Ambiguous invite outcome: re-derive ownership by EXACT email (bound to
      // the onboarding id). A user found only now is NOT ours to delete.
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
  await safeAdvance(deps, ob, "linking_profile");
  const link = await deps.rpc("link_first_company_admin", {
    p_onboarding: ob, p_auth_user_id: authUserId, p_created_by_us: createdByUs,
  });
  if (link.error) {
    const code = toSafeError(link.error.message);
    if (code === "email_already_linked") return failOnboarding("email_already_linked", true);
    // Compensate ONLY a user we confidently created this attempt.
    if (createdByUs) { try { await deps.authAdmin.deleteUser(authUserId); } catch (_) { /* ignore */ } }
    return failOnboarding(code, false);
  }

  // 4) Setup email (non-fatal, separate from progression). invite() already
  //    requested the email; adopted users get a recovery/setup email.
  let emailStatus = "requested";
  if (via === "recovery") {
    const em = await deps.sendRecoveryEmail(input.first_admin_email);
    emailStatus = em && em.error ? "failed" : "requested";
  }
  try {
    await deps.rpc("record_admin_setup_email_result", {
      p_onboarding: ob, p_result_status: emailStatus,
      p_safe_error_code: emailStatus === "failed" ? "setup_email_failed" : null, p_is_retry: false,
    });
  } catch (_) { /* email recording is best-effort */ }

  // 5) Activate (the RPC verifies the linked active admin before flipping status).
  const done = await deps.rpc("complete_company_onboarding", { p_onboarding: ob });
  if (done.error) return failOnboarding(toSafeError(done.error.message), false);

  return ok(done.data, input, emailStatus);
}

// Resend a password-setup email for an existing onboarding. Always uses the
// recovery email (never invite, never auth.resend), via the anon/caller client.
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
  if (rec.error) return { ok: false, error: toSafeError(rec.error.message) };
  return { ok: true, result: { setup_email_status: status } };
}
