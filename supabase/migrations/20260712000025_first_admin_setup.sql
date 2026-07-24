-- ============================================================
-- Migration 25 (Stage 4B security amendment) — First-Admin Setup Finalization
--
-- Closes the access-control gap in Stage 4B-1: a valid invitation / recovery
-- email link mints an authentication-capable session, so activating the first
-- Company Admin's profile at link time (Migration 24) would let the invited
-- user reach the app BEFORE choosing a password. set-password.html is a UI, not
-- a security boundary. This migration makes setup access DATABASE-ENFORCED.
--
-- Model (kept as small as practical — NO new onboarding enum state; the
-- "account setup pending" condition is DERIVED):
--   * link_first_company_admin now links role=admin + company_id but leaves the
--     first-admin profile active = FALSE.
--   * complete_company_onboarding still activates the COMPANY (pending_setup ->
--     active) and reaches state='completed' — with the admin still inactive.
--   * "Account setup pending"  == onboarding.state='completed'
--                                 AND admin_setup_completed_at IS NULL
--                                 AND the linked first-admin profile.active=false.
--   * finalize_first_admin_setup() activates ONLY the caller's own profile and
--     stamps admin_setup_completed_at — never touching onboarding state.
--
-- Because every operational identity helper (app.my_company_id / my_role /
-- my_driver_id / my_outlet_id / my_vehicle_id / is_admin) already gates on
-- profile.active, an inactive first-admin has ZERO operational access with NO
-- new policy surface: my_company_id() and my_role() return NULL, admin.html
-- renders no data, and checkAccess() rejects the login.
--
-- Password-authentication PROOF (see the local GoTrue evidence captured in the
-- amendment report): a fresh signInWithPassword session carries an AMR claim
-- amr = [{ "method": "password", ... }] (RFC 8176), whereas invite/recovery
-- sessions carry method="otp". updateUser({password}) does NOT upgrade the held
-- invite token's amr in place. So finalization requires a genuine
-- password-authenticated session — proven server-side from request.jwt.claims —
-- and NEVER depends on auth.users.encrypted_password (an internal Auth field).
-- ============================================================

-- ---- 1) Password-authentication proof helper -------------------------------
-- True only when the CURRENT request's verified JWT claims carry an AMR entry
-- with method='password'. PostgREST populates request.jwt.claims from the
-- cryptographically verified access token, so this reflects a real password
-- sign-in (signInWithPassword) and rejects invite/recovery (otp) sessions.
-- Reading current_setting directly (same source as auth.jwt()) keeps this
-- self-contained and testable.
create or replace function app.request_has_password_amr()
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      coalesce(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'amr',
        '[]'::jsonb)) e
    where e ->> 'method' = 'password');
$$;

-- ---- 2) Profile-field guard: narrow first-admin finalize path --------------
-- Migration 24 added the onboarding profile-link marker (app_admin + postgres).
-- Finalization is driven by the INVITED admin (not an app_admin), so it needs
-- its own narrow path: a transaction-local marker set ONLY inside
-- finalize_first_admin_setup, the SECURITY DEFINER postgres context, AND the
-- row being changed must be the caller's own profile (new.user_id = auth.uid()).
-- The RPC has already verified the AMR password proof, the onboarding ownership,
-- and every precondition before it sets this marker around the single UPDATE.
create or replace function app.protect_profile_fields()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- Trusted onboarding profile-link path (marker + postgres context + app_admin).
  if current_setting('app.onboarding_profile_link', true) = 'on'
     and current_user = 'postgres'
     and app.is_app_admin() then
    return new;
  end if;

  -- Trusted first-admin FINALIZE path: the invited admin activating their own
  -- profile exactly once. Guarded by the finalize marker, the postgres context,
  -- and an ownership match on the caller's own row.
  if current_setting('app.first_admin_finalize', true) = 'on'
     and current_user = 'postgres'
     and new.user_id = auth.uid() then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if not app.is_admin() and (
       new.role       is distinct from old.role
    or new.company_id is distinct from old.company_id
    or new.outlet_id  is distinct from old.outlet_id
    or new.driver_id  is distinct from old.driver_id
    or new.vehicle_id is distinct from old.vehicle_id
    or new.active     is distinct from old.active
  ) then
    raise exception 'Only an admin can change role, company, or assignments';
  end if;

  return new;
end;
$$;

-- ---- 3) New onboarding columns ---------------------------------------------
alter table public.company_onboarding
  add column if not exists admin_setup_completed_at timestamptz,
  add column if not exists setup_started_at         timestamptz;

-- ---- 4) "linked" no longer implies "active" --------------------------------
-- The first admin is intentionally inactive until password-setup finalization,
-- so genuine linkage is: auth_user_id known, profile matches the auth user AND
-- the onboarding company, role=admin, and no outlet/driver/vehicle links.
-- (Dropping the previous active=true requirement is what lets
-- complete_company_onboarding and the setup-email gates operate on the
-- linked-but-inactive first admin.)
create or replace function app.onboarding_admin_linked_ok(p public.company_onboarding)
returns boolean
language plpgsql
stable
set search_path = pg_catalog
as $$
declare v_prof public.profiles;
begin
  if p.auth_user_id is null then return false; end if;
  select * into v_prof from public.profiles where user_id = p.auth_user_id;
  if not found then return false; end if;
  return v_prof.user_id = p.auth_user_id
     and v_prof.company_id = p.company_id
     and v_prof.role::text = 'admin'
     and v_prof.outlet_id is null
     and v_prof.driver_id is null
     and v_prof.vehicle_id is null;
end;
$$;

-- ---- 5) Safe status payload now carries the setup milestones ---------------
-- Additive: exposes the derived setup-pending signals to the App Admin timeline
-- (get_company_onboarding_status). No secrets.
create or replace function app.onboarding_status_json(p public.company_onboarding)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'onboarding_id', p.id,
    'company_id', p.company_id,
    'company_code', p.company_code,
    'state', p.state,
    'attempt_count', p.attempt_count,
    'auth_user_id', p.auth_user_id,
    'setup_email_status', p.setup_email_status,
    'setup_email_attempt_count', p.setup_email_attempt_count,
    'error_code', p.error_code,
    'setup_started_at', p.setup_started_at,
    'admin_setup_completed_at', p.admin_setup_completed_at,
    'completed_at', p.completed_at);
$$;

-- ---- 6) link_first_company_admin: link but leave the profile INACTIVE ------
-- Identical to Migration 24 EXCEPT the linked first-admin profile is created
-- active = FALSE. Everything else (matrix enforcement, idempotency, audit,
-- state='admin_linked') is unchanged.
create or replace function public.link_first_company_admin(
  p_onboarding uuid, p_auth_user_id uuid, p_created_by_us boolean, p_processing_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_ob    public.company_onboarding;
  v_class text;
  v_uid   uuid;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  if p_auth_user_id is null then raise exception 'invalid_input'; end if;

  select * into v_ob from public.company_onboarding where id = p_onboarding for update;
  if not found then raise exception 'invalid_input'; end if;
  if not app.onboarding_owner_ok(v_ob, p_processing_token) then raise exception 'onboarding_in_progress'; end if;
  perform 1 from public.companies where id = v_ob.company_id for update;

  -- Idempotent replay: already linked to this auth user.
  if v_ob.state = 'admin_linked' and v_ob.auth_user_id = p_auth_user_id then
    return app.onboarding_status_json(v_ob);
  end if;

  if v_ob.state not in ('company_created', 'resolving_auth_user', 'linking_profile', 'failed_retriable') then
    raise exception 'invalid_state_transition';
  end if;

  select c.auth_user_id, c.classification into v_uid, v_class from app.onboarding_classify(v_ob) c;

  -- The resolved user must match the email's actual owner.
  if v_uid is distinct from p_auth_user_id then raise exception 'invalid_input'; end if;

  if v_class = 'linked_this_company_admin' then
    update public.company_onboarding
       set auth_user_id = p_auth_user_id, state = 'admin_linked', updated_at = now()
     where id = v_ob.id returning * into v_ob;
    return app.onboarding_status_json(v_ob);
  end if;

  if v_class <> 'unlinked_inactive' then
    raise exception 'email_already_linked';
  end if;

  -- Link the fully-unlinked, inactive profile as this company's admin, via the
  -- narrow onboarding profile-link marker. NOTE: active is left FALSE — the
  -- profile stays inert until password-setup finalization.
  perform set_config('app.onboarding_profile_link', 'on', true);
  update public.profiles
     set company_id = v_ob.company_id, role = 'admin', active = false, updated_at = now()
   where user_id = p_auth_user_id;
  perform set_config('app.onboarding_profile_link', 'off', true);

  update public.company_onboarding
     set auth_user_id = p_auth_user_id, auth_user_created_by_us = coalesce(p_created_by_us, false),
         state = 'admin_linked', updated_at = now()
   where id = v_ob.id returning * into v_ob;

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, target_user_id, details)
  values (v_actor,
          case when coalesce(p_created_by_us, false)
               then 'first_company_admin_auth_created'
               else 'first_company_admin_existing_user_adopted' end,
          v_ob.company_id, p_auth_user_id,
          jsonb_build_object('onboarding_id', v_ob.id, 'created_by_us', coalesce(p_created_by_us, false))),
         (v_actor, 'first_company_admin_linked', v_ob.company_id, p_auth_user_id,
          jsonb_build_object('onboarding_id', v_ob.id, 'new_state', 'admin_linked', 'profile_active', false));

  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 7) my_first_admin_setup_status ----------------------------------------
-- Read RPC for the INVITED (inactive) first admin. Derives auth.uid(), returns
-- ONLY the caller's own safe fields, and never exposes any other onboarding row.
-- Side effect (idempotent, once): the first time a genuinely pending first admin
-- reaches this — i.e. loads the Complete Account Setup screen — it stamps
-- setup_started_at and writes the first_admin_setup_started audit exactly once.
create or replace function public.my_first_admin_setup_status()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid  uuid := auth.uid();
  v_ob   public.company_onboarding;
  v_prof public.profiles;
  v_co   public.companies;
  v_required boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('required', false);
  end if;

  -- The caller's own onboarding, if any (they are the linked first admin).
  select * into v_ob from public.company_onboarding
   where auth_user_id = v_uid
   order by created_at desc limit 1 for update;
  if not found then
    return jsonb_build_object('required', false);
  end if;

  select * into v_prof from public.profiles where user_id = v_uid;
  select * into v_co   from public.companies where id = v_ob.company_id;

  -- Pending setup is DERIVED: company activated, admin linked + still inactive,
  -- finalization not yet done.
  v_required := v_ob.admin_setup_completed_at is null
            and v_ob.state = 'completed'
            and v_prof.user_id is not null
            and v_prof.company_id = v_ob.company_id
            and v_prof.role::text = 'admin'
            and not v_prof.active
            and v_co.status = 'active';

  if v_required and v_ob.setup_started_at is null then
    update public.company_onboarding
       set setup_started_at = now(), updated_at = now()
     where id = v_ob.id;
    insert into public.platform_audit_log (actor_user_id, action, target_company_id, target_user_id, details)
    values (v_uid, 'first_admin_setup_started', v_ob.company_id, v_uid,
            jsonb_build_object('onboarding_id', v_ob.id));
  end if;

  return jsonb_build_object(
    'required', v_required,
    'onboarding_id', v_ob.id,
    'company_name', v_ob.company_name,
    'state', v_ob.state,
    'admin_setup_completed_at', v_ob.admin_setup_completed_at);
end;
$$;

-- ---- 8) finalize_first_admin_setup -----------------------------------------
-- The protected finalization contract. Derives the caller from auth.uid(),
-- accepts NOTHING from the browser, requires the AMR password proof, activates
-- ONLY the caller's own linked admin profile, stamps admin_setup_completed_at,
-- audits once, is idempotent, and rejects every other user.
create or replace function public.finalize_first_admin_setup()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid  uuid := auth.uid();
  v_ob   public.company_onboarding;
  v_prof public.profiles;
  v_co   public.companies;
begin
  if v_uid is null then raise exception 'not_allowed'; end if;

  -- Find ONLY the caller's own onboarding; lock it. Prefer the one still
  -- awaiting finalization; fall back to an already-finalized one for idempotency.
  select * into v_ob from public.company_onboarding
   where auth_user_id = v_uid and state = 'completed'
   order by (admin_setup_completed_at is null) desc, created_at desc
   limit 1 for update;
  if not found then raise exception 'not_allowed'; end if;

  -- Lock the profile + company rows too.
  select * into v_prof from public.profiles  where user_id = v_uid for update;
  select * into v_co   from public.companies where id = v_ob.company_id for update;
  if not found then raise exception 'not_allowed'; end if;

  -- Idempotent success: already finalized (profile active, timestamp set).
  if v_ob.admin_setup_completed_at is not null and v_prof.active then
    return jsonb_build_object('finalized', true, 'company_id', v_ob.company_id,
                              'already_completed', true);
  end if;

  -- Preconditions for a first completion.
  if not (v_prof.user_id = v_uid
          and v_prof.company_id = v_ob.company_id
          and v_prof.role::text = 'admin'
          and not v_prof.active
          and v_co.status = 'active') then
    raise exception 'not_allowed';
  end if;

  -- REQUIRED password-authentication proof: the caller's verified session must
  -- carry amr method='password' (a fresh signInWithPassword session). An
  -- invite/recovery (otp) session is rejected here.
  if not app.request_has_password_amr() then
    raise exception 'setup_proof_required';
  end if;

  -- Activate ONLY the caller's own profile, via the narrow finalize marker.
  perform set_config('app.first_admin_finalize', 'on', true);
  update public.profiles set active = true, updated_at = now() where user_id = v_uid;
  perform set_config('app.first_admin_finalize', 'off', true);

  update public.company_onboarding
     set admin_setup_completed_at = now(), updated_at = now()
   where id = v_ob.id returning * into v_ob;

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, target_user_id, details)
  values (v_uid, 'first_company_admin_setup_completed', v_ob.company_id, v_uid,
          jsonb_build_object('onboarding_id', v_ob.id));

  return jsonb_build_object('finalized', true, 'company_id', v_ob.company_id,
                            'already_completed', false);
end;
$$;

-- ---- 9) Grants -------------------------------------------------------------
-- request_has_password_amr is an internal helper (invoked inside the RPC).
revoke all on function app.request_has_password_amr() from public, anon;

-- The two new RPCs are called by the INVITED first admin (an ordinary
-- authenticated user, NOT an app_admin), so they are granted to authenticated
-- and gate on auth.uid()/onboarding ownership internally — never on app_admin.
revoke all on function public.my_first_admin_setup_status()  from public, anon;
grant  execute on function public.my_first_admin_setup_status()  to authenticated;
revoke all on function public.finalize_first_admin_setup()   from public, anon;
grant  execute on function public.finalize_first_admin_setup()   to authenticated;
