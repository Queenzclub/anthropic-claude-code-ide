// Edge Function: create-company (Stage 4B-1).
//
// Onboards a new company for the dedicated App Admin. Authorizes the caller's
// bearer token, confirms an ACTIVE app_admin via the database, then runs the
// protected onboarding workflow. The service-role key is used ONLY for
// inviteUserByEmail — the workflow has no capability to remove Auth users.
// Every DB/RPC call uses the caller's forwarded JWT so app.is_app_admin()
// authorizes it server-side. No secrets or links are ever returned to the
// browser.
//
// NOT DEPLOYED in Stage 4B-1. `verify_jwt` handling: see the note below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, errorResponse, json, readJson } from "../_shared/http.ts";
import { readConfig, validateInput } from "../_shared/validate.ts";
import { Deps, runCreateCompany } from "../_shared/onboarding.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
// Startup config validation: throws (and the function fails to boot) when
// ALLOWED_ORIGIN or SET_PASSWORD_URL is missing/invalid. SET_PASSWORD_URL is
// REQUIRED and is a full URL including the GitHub Pages repository path
// (https://queenzclub.github.io/anthropic-claude-code-ide/set-password.html) —
// it is never derived from ALLOWED_ORIGIN (which is only the HTTP origin) and
// never accepted from the request body.
const CFG = readConfig({
  ALLOWED_ORIGIN: Deno.env.get("ALLOWED_ORIGIN"),
  SET_PASSWORD_URL: Deno.env.get("SET_PASSWORD_URL"),
});
const ALLOWED_ORIGIN = CFG.allowedOrigin;
const SET_PASSWORD_URL = CFG.setPasswordUrl;

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(ALLOWED_ORIGIN);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return errorResponse("not_allowed", 405, cors);

  // Defense in depth: even with the platform `verify_jwt` gateway setting on,
  // we require + validate the bearer ourselves.
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!token) return errorResponse("not_allowed", 401, cors);

  // Caller-scoped client: carries the App Admin's JWT. Used for ALL RPCs.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  // Confirm an ACTIVE app_admin against the DB (not JWT metadata).
  const who = await userClient.auth.getUser();
  if (who.error || !who.data?.user) return errorResponse("not_allowed", 401, cors);
  const acc = await userClient.rpc("my_account_access");
  const isAppAdmin = !acc.error && acc.data && acc.data.role === "app_admin" && acc.data.active === true;
  if (!isAppAdmin) return errorResponse("not_allowed", 403, cors);

  const body = await readJson(req);
  if (!body) return errorResponse("invalid_input", 400, cors);
  const v = validateInput({
    company_name: body.company_name,
    company_code: body.company_code,
    timezone: body.timezone,
    first_admin_name: body.first_admin_name,
    first_admin_email: body.first_admin_email,
    idempotency_key: body.idempotency_key,
  });
  if (!v.ok) return errorResponse("invalid_input", 400, cors);

  // Service-role client: Auth Admin API ONLY.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const deps: Deps = {
    rpc: (fn, args) => userClient.rpc(fn, args),
    authAdmin: {
      inviteUserByEmail: async (email) => {
        const r = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: SET_PASSWORD_URL });
        if (r.error) {
          const already = /already/i.test(r.error.message || "");
          return { alreadyExists: already, error: already ? null : r.error };
        }
        return { userId: r.data?.user?.id ?? null };
      },
      // Invite is the ONLY Auth Admin operation. The workflow has no capability
      // to remove Auth users (a link RPC may have committed while its response
      // was lost).
    },
    // Recovery/setup email uses the ANON/caller client — never service-role.
    sendRecoveryEmail: async (email) => {
      const r = await userClient.auth.resetPasswordForEmail(email, { redirectTo: SET_PASSWORD_URL });
      return { error: r.error };
    },
  };

  try {
    const outcome = await runCreateCompany(deps, v.value);
    if (!outcome.ok) {
      const status = outcome.error === "not_allowed" ? 403
        : outcome.error === "invalid_input" ? 400
        : outcome.error === "company_code_exists" || outcome.error === "email_already_linked"
          || outcome.error === "idempotency_conflict" ? 409
        : 422;
      return errorResponse(outcome.error, status, cors);
    }
    return json(outcome.result, 200, cors);
  } catch (_e) {
    // Never leak internals.
    return errorResponse("onboarding_failed", 500, cors);
  }
});
