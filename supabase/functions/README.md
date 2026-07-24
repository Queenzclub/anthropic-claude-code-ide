# Edge Functions — Secure Company Onboarding (Stage 4B)

These functions let the dedicated **App Admin** onboard a new company without
ever exposing `service_role` in the browser. **They are not deployed yet** and
must not be deployed until the live-configuration steps below are done and the
change is approved.

## Functions

- **`create-company`** — validates the caller (active `app_admin`), then runs
  the onboarding workflow: `begin_company_onboarding` → claim the processing
  lease → resolve/invite the first admin's Auth user →
  `link_first_company_admin` → `complete_company_onboarding`. Returns only safe
  fields (`company_id`, `company_code`, `status`, `admin_email`,
  `setup_email_status`). Since the Stage 4B security amendment (Migration 25),
  `link_first_company_admin` leaves the first-admin profile **inactive** and
  `complete_company_onboarding` activates the company while the admin still
  awaits password setup.
- **`send-admin-setup-email`** — re-sends the first admin's password-setup
  email (recovery email) for an existing onboarding whose admin is already
  linked. Never invites, never `auth.resend()`, never returns a link. Uses no
  service-role key at all.
- **`complete-first-admin-setup`** — the **database-enforced setup boundary**
  (Migration 25). Called by the invited first admin from `set-password.html`
  with a **fresh password-authenticated session** (obtained via
  `signInWithPassword` after `updateUser`). It forwards that token to the
  protected `finalize_first_admin_setup()` RPC, which requires the AMR password
  proof (`amr` contains `method='password'` — an invite/recovery `otp` session
  is rejected with `setup_proof_required`), then activates **only the caller's
  own** profile and stamps `admin_setup_completed_at`. **No service-role client
  at all** — everything runs under the caller's JWT; the RPC authorizes via
  `auth.uid()`. Returns only `{ finalized, already_completed }`.

### Why the password proof is AMR, not `encrypted_password`

Verified against a local GoTrue (Supabase Auth) v2.174.0 runtime: an
invite/recovery session carries `amr = [{ "method": "otp" }]`, while a fresh
`signInWithPassword` session carries `amr = [{ "method": "password" }]`, and
`updateUser({ password })` does **not** upgrade the held invite token's `amr`.
So finalization depends on a genuine password session (proven server-side from
`request.jwt.claims`) — never on `auth.users.encrypted_password`, which is an
internal Auth storage field, not a stable security contract.

Shared logic lives in `_shared/` and is unit-tested in
`tests/onboarding_logic_test.ts` (runs under Deno or
`node --experimental-strip-types`).

## Security model

- **Two clients, strictly separated.** The **caller-scoped App Admin JWT**
  client makes every onboarding RPC / DB write. The **service-role/secret**
  client is used **only for `inviteUserByEmail`** — nothing else. The
  recovery/setup email uses the caller client's `resetPasswordForEmail`, never
  the service-role client.
- **No automatic Auth-user deletion exists.** The workflow has no capability to
  remove Auth users. After an ambiguous link result it re-reads the onboarding
  state; an unlinked account is preserved and adopted on retry.
- **Processing lease.** Each execution generates a server-side processing
  token (never accepted from the browser) and must claim the onboarding before
  any Auth/email operation; every state-mutating RPC verifies the token, so a
  concurrent execution receives `onboarding_in_progress` and performs no side
  effects. Completion/failure release the lease atomically; expiry allows
  recovery after a crash. No DB transaction is held open across Auth API calls.
- **App admin verified twice:** at the function door (`auth.getUser` +
  `my_account_access`) and again inside every RPC (`app.is_app_admin()`).
- **Never returned/logged:** secrets, passwords, tokens, or invite/recovery
  links.
- **Request body never carries** role, company status, actor id, linkage ids,
  a redirect URL, or a processing token.
- **Origin vs application path.** `ALLOWED_ORIGIN` is the HTTP origin only
  (`https://queenzclub.github.io`) and is used for CORS. The app itself lives
  under the GitHub Pages repository path, so `SET_PASSWORD_URL` must be the
  full page URL including that path — it is **mandatory**, validated at
  startup (HTTPS required outside local development), and never derived from
  `ALLOWED_ORIGIN`.

## Required environment secrets (set with `supabase secrets set`, never commit)

```
SUPABASE_URL       = https://<project>.supabase.co
SUPABASE_ANON_KEY  = <anon/publishable key>
SERVICE_ROLE_KEY   = <service-role/secret key>   # create-company only; server-side only
ALLOWED_ORIGIN     = https://queenzclub.github.io
SET_PASSWORD_URL   = https://queenzclub.github.io/anthropic-claude-code-ide/set-password.html
```

`complete-first-admin-setup` needs only `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
and `ALLOWED_ORIGIN` (no service-role, no `SET_PASSWORD_URL`).

Local development may point `ALLOWED_ORIGIN` / `SET_PASSWORD_URL` at a
localhost origin (http is accepted for localhost only).

## Live configuration still required (before deploy)

1. Apply **Migration 24** then **Migration 25** and run
   `supabase/tests/verify_migration_24.sql` and `verify_migration_25.sql`.
2. **Inspect the project's API-key type** (legacy JWT anon/service vs new
   publishable/secret) and set `verify_jwt` accordingly. Regardless of that
   setting, these functions require a bearer, validate it with `auth.getUser()`,
   and (for the two app_admin functions) re-check `app_admin` in the DB;
   `complete-first-admin-setup` instead lets the `finalize_first_admin_setup()`
   RPC authorize the caller via `auth.uid()` + the AMR password proof.
3. Configure **custom SMTP** in Supabase Auth (the default sender is
   rate-limited).
4. Add the PWA origin + `set-password.html` (full path above) to Auth
   **Site URL** and **Redirect URLs**.
5. `supabase secrets set …` (above), then deploy **all three** functions
   together — the finalization path must be live before any invitation is sent:
   `supabase functions deploy create-company send-admin-setup-email complete-first-admin-setup`.
6. Verify backend health **without sending an invitation**, then ship the Stage
   4B-2 frontend (`fleetboard-v21`) and test a throwaway onboarding end-to-end,
   confirming the pre-finalization admin is blocked from the app.

CORS is restricted to `ALLOWED_ORIGIN`; `OPTIONS` is handled; bodies must be
`application/json` and are size-capped. The preflight advertises
`Access-Control-Allow-Headers: authorization, x-client-info, apikey,
content-type` — the four headers supabase-js attaches on every
`functions.invoke` request (omitting `apikey`/`x-client-info` makes the browser
reject the preflight).
