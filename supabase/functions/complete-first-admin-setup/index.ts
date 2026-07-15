// Edge Function: complete-first-admin-setup (Stage 4B security amendment).
//
// The database-enforced setup boundary. Called by an invited first Company
// Admin AFTER they have (1) consumed their invite/recovery link, (2) chosen a
// password via auth.updateUser, and (3) obtained a FRESH password-authenticated
// session via auth.signInWithPassword. The browser sends THAT fresh session's
// bearer token here.
//
// Security model:
//   * No service-role client. Everything runs under the caller's forwarded JWT.
//   * The protected RPC finalize_first_admin_setup() is the authority: it
//     derives the user from auth.uid(), accepts NOTHING from the browser, and
//     requires the password-authentication PROOF — an amr claim with
//     method='password' in the verified request.jwt.claims. An invite/recovery
//     (otp) session is rejected there with setup_proof_required.
//   * We forward the token so PostgREST populates request.jwt.claims (incl. amr)
//     for that RPC. This function only maps outcomes to safe codes + CORS.
//   * It NEVER routes into the app and NEVER returns secrets.
//
// NOT DEPLOYED as part of this change. Deploy alongside create-company /
// send-admin-setup-email, only after Migration 24 + 25 are applied.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, errorResponse, json } from "../_shared/http.ts";
import { mapFinalizeError, safeFinalizeResult } from "../_shared/finalize.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// ALLOWED_ORIGIN is a required env secret (production: https://queenzclub.github.io).
const ALLOWED_ORIGIN = (Deno.env.get("ALLOWED_ORIGIN") || "").trim();
if (!ALLOWED_ORIGIN) throw new Error("ALLOWED_ORIGIN is required");

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(ALLOWED_ORIGIN);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return errorResponse("not_allowed", 405, cors);

  // Require + validate the bearer ourselves (defense in depth vs. the gateway
  // verify_jwt setting). This must be the FRESH password session's token.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
  if (!token) return errorResponse("not_allowed", 401, cors);

  // Caller-scoped client only. No service-role anywhere in this function.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  // Confirm the token resolves to a real session before touching the RPC.
  const who = await userClient.auth.getUser();
  if (who.error || !who.data?.user) return errorResponse("not_allowed", 401, cors);

  try {
    // The RPC is authoritative: it re-derives auth.uid(), re-checks the amr
    // password proof from the verified claims, and activates ONLY the caller's
    // own linked admin profile. We pass nothing from the request body.
    const r = await userClient.rpc("finalize_first_admin_setup");
    if (r.error) {
      const mapped = mapFinalizeError((r.error as { message?: string }).message);
      return errorResponse(mapped.code, mapped.status, cors);
    }
    // r.data = { finalized, company_id, already_completed }. Return safe fields only.
    return json(safeFinalizeResult(r.data), 200, cors);
  } catch (_e) {
    return errorResponse("setup_failed", 500, cors);
  }
});
