// Edge Function: send-admin-setup-email (Stage 4B-1).
//
// Re-sends the first Company Admin's password-setup email for an existing
// onboarding (expired / lost / uncertain original). Always a password-recovery
// email via the ANON/caller client — never inviteUserByEmail, never
// auth.resend(), never a generated link returned to the browser. The target
// email is derived server-side from the onboarding id (never caller-supplied).
//
// NOT DEPLOYED in Stage 4B-1.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, errorResponse, json, readJson } from "../_shared/http.ts";
import { Deps, runSendSetupEmail } from "../_shared/onboarding.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN")!;
const SET_PASSWORD_URL = Deno.env.get("SET_PASSWORD_URL") ?? `${ALLOWED_ORIGIN}/set-password.html`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(ALLOWED_ORIGIN);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return errorResponse("not_allowed", 405, cors);

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!token) return errorResponse("not_allowed", 401, cors);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const who = await userClient.auth.getUser();
  if (who.error || !who.data?.user) return errorResponse("not_allowed", 401, cors);
  const acc = await userClient.rpc("my_account_access");
  const isAppAdmin = !acc.error && acc.data && acc.data.role === "app_admin" && acc.data.active === true;
  if (!isAppAdmin) return errorResponse("not_allowed", 403, cors);

  const body = await readJson(req);
  const onboardingId = body && typeof body.onboarding_id === "string" ? body.onboarding_id : "";
  if (!UUID_RE.test(onboardingId)) return errorResponse("invalid_input", 400, cors);

  // Note: no service-role client is constructed here — resend uses only the
  // caller client's resetPasswordForEmail.
  const deps: Deps = {
    rpc: (fn, args) => userClient.rpc(fn, args),
    authAdmin: {
      inviteUserByEmail: () => Promise.resolve({ error: { message: "not_used" } }),
    },
    sendRecoveryEmail: async (email) => {
      const r = await userClient.auth.resetPasswordForEmail(email, { redirectTo: SET_PASSWORD_URL });
      return { error: r.error };
    },
  };

  try {
    const outcome = await runSendSetupEmail(deps, onboardingId);
    if (!outcome.ok) {
      const status = outcome.error === "not_allowed" ? 403 : outcome.error === "invalid_input" ? 400 : 422;
      return errorResponse(outcome.error, status, cors);
    }
    return json(outcome.result, 200, cors);
  } catch (_e) {
    return errorResponse("onboarding_failed", 500, cors);
  }
});
