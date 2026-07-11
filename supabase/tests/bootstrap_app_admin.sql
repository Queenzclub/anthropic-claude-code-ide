-- ============================================================
-- Fleet Board Pro — FIRST app_admin bootstrap (TEMPLATE)
--
-- Run ONCE, manually, in the Supabase SQL Editor, as part of this order:
--   1. Apply Migration 23.
--   2. Run verify_migration_23.sql Part A (structure & grants).
--   3. Create a SEPARATE, dedicated Supabase Auth account for the platform
--      owner (Authentication → Add user) — e.g. platform@yourdomain. Do NOT
--      reuse a Company Admin login.
--   4. Confirm that account now has a row in public.profiles
--      (select user_id, role from public.profiles where email = '<that email>').
--   5. Run THIS template for that separate account (fill in its email).
--   6. Verify role = app_admin, company_id IS NULL, active = true.
--   7. Run verify_migration_23.sql Part B (app_admin + ordinary-role blocks).
--
-- WHY A SEPARATE ACCOUNT: promoting a company's only Company Admin turns
-- that account into a platform owner (company_id becomes NULL), leaving the
-- company with NO administrator. Always use a dedicated app_admin login.
--
-- This is the ONLY supported way to create the first platform owner: there
-- is no signup path and no in-app path. The profiles_protect_app_admin
-- trigger permits this change ONLY from the trusted manual context — the
-- Supabase SQL Editor / migration runner, where current_user AND
-- session_user are both 'postgres'. It deliberately does NOT permit
-- service_role or any authenticated/anon (browser) role to assign or remove
-- app_admin. (Confirm your editor context first: select current_user,
-- session_user;  -> expect  postgres | postgres.)
--
-- This template contains NO real UUID or email — fill it in at run time.
-- It is wrapped in a transaction with safety checks and writes an audit row
-- (actor_user_id is NULL: a trusted SQL-Editor bootstrap has no
-- authenticated platform actor).
-- ============================================================

begin;

do $$
declare
  v_email text := 'REPLACE_WITH_YOUR_LOGIN_EMAIL';   -- <-- the future app_admin's email
  v_user  uuid;
  v_role  text;
begin
  -- Resolve the auth user by email (must match exactly one).
  select u.id into v_user from auth.users u where lower(u.email) = lower(v_email);
  if v_user is null then
    raise exception 'No auth user with email %. Have them sign up first.', v_email;
  end if;

  -- Must already have a profile (created by the signup trigger).
  select p.role::text into v_role from public.profiles p where p.user_id = v_user;
  if v_role is null then
    raise exception 'No profile for %. Attach them first, then re-run.', v_email;
  end if;

  -- Promote to app_admin: platform role, no company, active.
  update public.profiles
     set role = 'app_admin', company_id = null, active = true
   where user_id = v_user;

  -- Audit the bootstrap (append-only). actor is NULL by design.
  insert into public.platform_audit_log (actor_user_id, action, target_user_id, details)
  values (
    null,
    'app_admin_bootstrapped',
    v_user,
    jsonb_build_object(
      'method',        'trusted SQL Editor bootstrap',
      'previous_role', v_role,
      'email',         v_email));

  raise notice 'app_admin bootstrapped for % (user %). Review below, then COMMIT.', v_email, v_user;
end $$;

-- Review the result before committing.
-- select user_id, role, company_id, active from public.profiles where role = 'app_admin';
-- select * from public.platform_audit_log where action = 'app_admin_bootstrapped' order by created_at desc;

-- If everything looks correct:
commit;
-- Otherwise:
-- rollback;
