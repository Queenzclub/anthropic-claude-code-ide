# Edge Functions — Secure Company Onboarding (Stage 4B-1)

These functions let the dedicated **App Admin** onboard a new company without
ever exposing `service_role` in the browser. **They are not deployed yet** and
must not be deployed until the live-configuration steps below are done and the
change is approved.

## Functions

- **`create-company`** — validates the caller (active `app_admin`), then runs
  the onboarding workflow: `begin_company_onboarding` → resolve/invite the first
  admin's Auth user → `link_first_company_admin` → `complete_company_onboarding`.
  Returns only safe fields (`company_id`, `company_code`, `status`,
  `admin_email`, `setup_email_status`).
- **`send-admin-setup-email`** — re-sends the first admin's password-setup email
  (recovery email) for an existing onboarding. Never invites, never
  `auth.resend()`, never returns a link.

Shared logic lives in `_shared/` and is unit-tested in
`tests/onboarding_logic_test.ts` (runs under Deno or
`node --experimental-strip-types`).

## Security model

- **Two clients, strictly separated.** The **caller-scoped App Admin JWT**
  client makes every onboarding RPC / DB write. The **service-role** client is
  used **only** for the Auth Admin API (`inviteUserByEmail`, `deleteUser`).
  The recovery/setup email uses the caller client's `resetPasswordForEmail`,
  never the service-role client.
- **App admin verified twice:** at the function door (`auth.getUser` +
  `my_account_access`) and again inside every RPC (`app.is_app_admin()`).
- **Never returned/logged:** `service_role`, passwords, tokens, or invite/
  recovery links.
- **Request body never carries** role, company status, actor id, or linkage ids.

## Required environment secrets (set with `supabase secrets set`, never commit)

```
SUPABASE_URL           = https://<project>.supabase.co
SUPABASE_ANON_KEY      = <anon/publishable key>
SERVICE_ROLE_KEY       = <service-role/secret key>   # server-side only
ALLOWED_ORIGIN         = https://queenzclub.github.io  # local dev: your localhost origin
SET_PASSWORD_URL       = https://queenzclub.github.io/set-password.html  # optional; defaults from ALLOWED_ORIGIN
```

## Live configuration still required (before deploy — not part of 4B-1)

1. Apply **Migration 24** and run `supabase/tests/verify_migration_24.sql`.
2. **Inspect the project's API-key type** (legacy JWT anon/service vs new
   publishable/secret) and set `verify_jwt` accordingly. Regardless of that
   setting, these functions require a bearer, validate it with `auth.getUser()`,
   and re-check `app_admin` in the DB.
3. Configure **custom SMTP** in Supabase Auth (the default sender is
   rate-limited).
4. Add the PWA origin + `set-password.html` to Auth **Site URL** and **Redirect
   URLs**.
5. `supabase secrets set …` (above), then `supabase functions deploy
   create-company send-admin-setup-email`.
6. Build the Stage 4B-2 frontend (`set-password.html` + Create Company form),
   then test a throwaway onboarding end-to-end.

CORS is restricted to `ALLOWED_ORIGIN`; `OPTIONS` is handled; bodies must be
`application/json` and are size-capped.
