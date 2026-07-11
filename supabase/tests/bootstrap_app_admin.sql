-- ============================================================
-- Fleet Board Pro — FIRST app_admin bootstrap (TEMPLATE)
--
-- Run ONCE, manually, in the Supabase SQL Editor, AFTER Migration 23 is
-- applied. This is the ONLY supported way to create the first platform
-- owner: there is no signup path, no in-app path, and ordinary Company
-- Admin / Manager users are blocked by the profiles_protect_app_admin
-- trigger. The SQL Editor runs as a trusted role (postgres), which is what
-- the trigger permits for this operation.
--
-- Prerequisites:
--   1. The person already has a Supabase Auth account (they signed up /
--      were added in Authentication → Users) and therefore a row in
--      public.profiles.
--   2. Replace the placeholder email below with THEIR real login email.
--
-- This template contains NO real UUID or email — fill it in at run time.
-- It is wrapped in a transaction with a safety check and writes an audit
-- row (actor_user_id is NULL: a trusted SQL-Editor bootstrap has no
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
