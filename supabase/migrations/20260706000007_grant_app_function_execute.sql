-- ============================================================
-- Fleet Board Pro — Migration 7: let authenticated run app.* helpers
--
-- Bug: migration 1 granted USAGE on schema `app` to `authenticated`
-- but never granted EXECUTE on the helper functions inside it
-- (app.my_company_id(), app.my_role(), app.is_staff(), …). On a
-- hardened Supabase project the default PUBLIC execute privilege is
-- not present, so `authenticated` could not call those functions —
-- and since every RLS policy except "read your own profile" depends
-- on them, logged-in users could read their own profile (login
-- worked) but every other read/write failed.
--
-- This is the RLS machinery itself; granting EXECUTE does NOT weaken
-- any policy or expose any data — it only allows the policies to run.
-- No table grants, no service_role, no policy changes.
-- ============================================================

grant usage on schema app to authenticated;

grant execute on all functions in schema app to authenticated;

-- Cover any helper functions added to the schema later.
alter default privileges in schema app grant execute on functions to authenticated;
