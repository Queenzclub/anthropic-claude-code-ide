-- ============================================================
-- Migration 24 (Stage 4B-1) — Secure Company Onboarding (backend)
--
-- Adds the server-side state machine + protected RPCs that let the dedicated
-- App Admin (app_admin) onboard a new company: create it as pending_setup,
-- create/adopt the first Company Admin, link the profile, and activate the
-- company only after the link is verified. Auth-account creation and the
-- setup email are performed by an Edge Function using the service-role key
-- (server-side only); this migration owns every DATABASE mutation, atomically,
-- through app_admin-gated SECURITY DEFINER RPCs.
--
-- Design invariants (see plan):
--   * Onboarding PROGRESSION is separate from EMAIL DELIVERY. A failed or
--     uncertain setup email never blocks admin_linked -> completed.
--   * Activation (pending_setup -> active) happens ONLY in
--     complete_company_onboarding, only after verifying the linked active
--     admin profile, and uses the Migration 23 lifecycle marker.
--   * Every RPC re-checks app.is_app_admin(), derives the actor from
--     auth.uid(), locks rows FOR UPDATE, guards state transitions, has a
--     locked search_path, fully-qualifies objects, and revokes public/anon.
--   * The request fingerprint is computed IN THE DATABASE from normalized
--     fields — never trusted from the caller.
--   * platform_audit_log rows carry actor/target/state/error only — never
--     passwords, tokens, or links.
-- ============================================================

-- ---- 0a) Company-code policy: case-insensitive uniqueness + format ---------
-- Approved codes are uppercase; case-equivalent duplicates are forbidden.
-- Preflight FIRST (fail loudly rather than silently mangling data), then
-- normalize existing codes to uppercase, add a case-insensitive unique index,
-- and enforce the format. Enforced in the DB, not just the Edge Function.
do $$
declare v_bad text;
begin
  -- Preflight 1: no case-insensitive duplicate codes.
  if exists (
    select 1 from public.companies group by upper(btrim(code)) having count(*) > 1
  ) then
    raise exception 'Migration 24 preflight failed: companies have case-insensitive duplicate codes (upper(trim(code))). Resolve the duplicates before applying.';
  end if;
  -- Preflight 2: every existing code matches the approved format after upper(trim()).
  select upper(btrim(code)) into v_bad from public.companies
   where upper(btrim(code)) !~ '^[A-Z0-9][A-Z0-9-]{2,31}$' limit 1;
  if v_bad is not null then
    raise exception 'Migration 24 preflight failed: existing company code % does not match ^[A-Z0-9][A-Z0-9-]{2,31}$ after uppercasing. Fix it before applying.', v_bad;
  end if;
end $$;

-- Normalize existing codes to uppercase (code is not a lifecycle field, so the
-- Migration 23 lifecycle guard does not apply).
update public.companies set code = upper(btrim(code)) where code <> upper(btrim(code));

-- Case-insensitive uniqueness + format check (in addition to the existing
-- exact-unique constraint from Migration 1).
create unique index if not exists companies_code_ci_uidx on public.companies (upper(code));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'companies_code_format_chk') then
    alter table public.companies
      add constraint companies_code_format_chk check (code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$');
  end if;
end $$;

-- ---- 0b) Profile-link marker for onboarding --------------------------------
-- link_first_company_admin must set role/company/active on the first admin's
-- profile. app.protect_profile_fields (Migration 1) normally blocks that unless
-- the caller is a Company Admin or a trusted no-auth.uid() setup session. We add
-- a NARROW onboarding path proven by ALL of: a transaction-local marker set only
-- by the onboarding RPC, the SECURITY DEFINER postgres context, AND an active
-- app_admin caller. The App Admin's real auth.uid() is retained throughout (we
-- never blank the JWT claim). Company Admin / SQL-editor / ordinary behavior is
-- unchanged.
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

-- ---- 1) Enums -------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_type where typname = 'onboarding_state') then
    create type public.onboarding_state as enum (
      'requested', 'company_created', 'resolving_auth_user', 'linking_profile',
      'admin_linked', 'completed', 'failed_retriable', 'failed_terminal');
  end if;
  if not exists (select 1 from pg_type where typname = 'setup_email_status') then
    create type public.setup_email_status as enum (
      'not_attempted', 'requested', 'failed', 'uncertain');
  end if;
end $$;

-- Permitted state transitions (enforced in the RPCs below):
--   (new)             -> requested -> company_created            [begin]
--   company_created   -> resolving_auth_user                     [advance]
--   resolving_auth_user -> linking_profile                       [advance]
--   {company_created, resolving_auth_user, linking_profile}
--                     -> admin_linked                            [link]
--   admin_linked      -> completed                               [complete]
--   {company_created, resolving_auth_user, linking_profile, admin_linked}
--                     -> failed_retriable | failed_terminal      [fail]
--   failed_retriable  -> resolving_auth_user (resume)            [retry]
--   completed, failed_terminal are sinks.

-- ---- 2) Table -------------------------------------------------------------

create table if not exists public.company_onboarding (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid references public.companies (id),
  requested_by             uuid not null references auth.users (id),
  admin_email_normalized   text not null,
  admin_name               text,
  company_name             text not null,
  company_code             text not null,
  timezone                 text not null,
  state                    public.onboarding_state not null default 'requested',
  resume_from_state        public.onboarding_state,
  attempt_count            integer not null default 0,
  idempotency_key          uuid not null unique,
  request_fingerprint      text not null,
  auth_user_id             uuid,
  -- Audit provenance ONLY (first_company_admin_auth_created vs
  -- first_company_admin_existing_user_adopted). Never used to authorize a
  -- destructive action — the workflow never deletes an Auth user.
  auth_user_created_by_us  boolean not null default false,
  setup_email_status       public.setup_email_status not null default 'not_attempted',
  setup_email_attempt_count integer not null default 0,
  setup_email_requested_at timestamptz,
  setup_email_error_code   text,
  error_code               text,
  safe_error_message       text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz
);

-- Only ONE in-flight onboarding per normalized email (a settled attempt —
-- completed or terminally failed — no longer reserves the address).
create unique index if not exists company_onboarding_email_inflight_uidx
  on public.company_onboarding (admin_email_normalized)
  where state not in ('completed', 'failed_terminal');

create index if not exists company_onboarding_company_idx
  on public.company_onboarding (company_id);
create index if not exists company_onboarding_state_idx
  on public.company_onboarding (state, created_at desc);

-- ---- 3) RLS: app_admin may READ onboarding rows; writes go via RPC only ---

alter table public.company_onboarding enable row level security;
revoke all on public.company_onboarding from anon, authenticated;
grant  select on public.company_onboarding to authenticated;  -- RLS still restricts

drop policy if exists company_onboarding_select_appadmin on public.company_onboarding;
create policy company_onboarding_select_appadmin on public.company_onboarding
  for select to authenticated using (app.is_app_admin());

-- ---- 4) Internal helpers --------------------------------------------------

-- Normalize + validate the request fields and compute the authoritative
-- fingerprint. Raises 'invalid_input' / 'company_code_exists' is handled by the
-- caller. Returns the normalized tuple as a record via OUT params.
create or replace function app.onboarding_normalize(
  p_company_name text, p_company_code text, p_timezone text,
  p_admin_name text, p_admin_email text,
  out o_company_name text, out o_company_code text, out o_timezone text,
  out o_admin_name text, out o_admin_email text, out o_fingerprint text)
returns record
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  o_company_name := btrim(coalesce(p_company_name, ''));
  o_company_code := upper(btrim(coalesce(p_company_code, '')));
  o_timezone     := btrim(coalesce(p_timezone, ''));
  o_admin_name   := btrim(coalesce(p_admin_name, ''));
  o_admin_email  := lower(btrim(coalesce(p_admin_email, '')));

  if o_company_name = '' then raise exception 'invalid_input'; end if;
  if o_admin_name   = '' then raise exception 'invalid_input'; end if;
  -- Approved company-code shape: A-Z0-9 start, then A-Z0-9/- , total 3..32.
  if o_company_code !~ '^[A-Z0-9][A-Z0-9-]{2,31}$' then raise exception 'invalid_input'; end if;
  -- Minimal email shape (Auth is the real validator).
  if o_admin_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_input'; end if;

  -- Authoritative fingerprint, computed here from normalized values only.
  o_fingerprint := md5(o_company_name || '|' || o_company_code || '|' || o_timezone
                       || '|' || o_admin_email || '|' || o_admin_name);
end;
$$;

-- Classify the account currently owning admin_email_normalized, RELATIVE to the
-- onboarding's target company. Returns (auth_user_id, classification) only.
-- Never returns Auth metadata, identities, tokens, or password data.
create or replace function app.onboarding_classify(p_onboarding public.company_onboarding)
returns table (auth_user_id uuid, classification text)
language plpgsql
stable
set search_path = pg_catalog
as $$
declare v_uid uuid; v_prof public.profiles;
begin
  select u.id into v_uid from auth.users u where lower(u.email) = p_onboarding.admin_email_normalized limit 1;
  if v_uid is null then
    return query select null::uuid, 'none'::text; return;
  end if;
  select * into v_prof from public.profiles where user_id = v_uid;
  if not found then
    -- Auth user with no profile row yet (rare: trigger race). Treat as unsafe
    -- to avoid acting on an unresolved account.
    return query select v_uid, 'active_other_role'::text; return;
  end if;
  if v_prof.role::text = 'app_admin' then
    return query select v_uid, 'is_app_admin'::text; return;
  end if;
  if v_prof.company_id = p_onboarding.company_id and v_prof.role::text = 'admin' then
    return query select v_uid, 'linked_this_company_admin'::text; return;
  end if;
  if v_prof.company_id is not null then
    return query select v_uid, 'linked_other_company'::text; return;
  end if;
  if not v_prof.active and v_prof.outlet_id is null and v_prof.driver_id is null and v_prof.vehicle_id is null then
    return query select v_uid, 'unlinked_inactive'::text; return;
  end if;
  return query select v_uid, 'active_other_role'::text;
end;
$$;

-- Safe status payload for the App Admin (no secrets).
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
    'completed_at', p.completed_at);
$$;

-- Verifies the onboarding's first admin is genuinely linked + active + clean:
-- auth_user_id known, profile matches the auth user AND the onboarding company,
-- role=admin, active, and no outlet/driver/vehicle links. Used by the
-- activation gate AND the setup-email gates.
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
     and v_prof.active
     and v_prof.outlet_id is null
     and v_prof.driver_id is null
     and v_prof.vehicle_id is null;
end;
$$;

-- ---- 5) begin_company_onboarding -----------------------------------------
-- Idempotent reservation. Creates EXACTLY ONE company (pending_setup) per key.
-- Replay: same key + same actor + same normalized fingerprint resumes/returns;
-- same key with a different actor or payload -> 'idempotency_conflict'.
create or replace function public.begin_company_onboarding(
  p_idempotency_key uuid, p_company_name text, p_company_code text,
  p_timezone text, p_admin_name text, p_admin_email text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_norm  record;
  v_ob    public.company_onboarding;
  v_company uuid;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;

  select * into v_norm from app.onboarding_normalize(
    p_company_name, p_company_code, p_timezone, p_admin_name, p_admin_email);

  if not exists (select 1 from pg_timezone_names where name = v_norm.o_timezone) then
    raise exception 'invalid_input';
  end if;

  -- Reserve the idempotency key. Only the row's creator proceeds to create the
  -- company; concurrent replays block on the unique key then resume.
  insert into public.company_onboarding (
    idempotency_key, requested_by, admin_email_normalized, admin_name,
    company_name, company_code, timezone, request_fingerprint, state)
  values (p_idempotency_key, v_actor, v_norm.o_admin_email, v_norm.o_admin_name,
    v_norm.o_company_name, v_norm.o_company_code, v_norm.o_timezone, v_norm.o_fingerprint, 'requested')
  on conflict (idempotency_key) do nothing
  returning * into v_ob;

  if not found then
    -- Existing key: lock, verify ownership + payload, then resume.
    select * into v_ob from public.company_onboarding
      where idempotency_key = p_idempotency_key for update;
    if v_ob.requested_by is distinct from v_actor
       or v_ob.request_fingerprint is distinct from v_norm.o_fingerprint then
      raise exception 'idempotency_conflict';
    end if;
    return app.onboarding_status_json(v_ob);
  end if;

  -- We created the reservation: create the company as pending_setup.
  begin
    insert into public.companies (name, code, timezone, status, active)
    values (v_norm.o_company_name, v_norm.o_company_code, v_norm.o_timezone, 'pending_setup', false)
    returning id into v_company;
  exception when unique_violation then
    raise exception 'company_code_exists';
  end;

  update public.company_onboarding
     set company_id = v_company, state = 'company_created', updated_at = now()
   where id = v_ob.id
   returning * into v_ob;

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, details)
  values (v_actor, 'company_onboarding_started', v_company,
          jsonb_build_object('onboarding_id', v_ob.id, 'new_state', 'requested')),
         (v_actor, 'company_record_created', v_company,
          jsonb_build_object('onboarding_id', v_ob.id, 'company_code', v_ob.company_code, 'new_state', 'company_created'));

  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 6) advance_company_onboarding_state ----------------------------------
-- Side-effect-free forward markers used by the Edge Function around the Auth
-- step: company_created -> resolving_auth_user -> linking_profile.
create or replace function public.advance_company_onboarding_state(
  p_onboarding uuid, p_to public.onboarding_state)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_ob public.company_onboarding;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  select * into v_ob from public.company_onboarding where id = p_onboarding for update;
  if not found then raise exception 'invalid_input'; end if;

  if not ((v_ob.state = 'company_created'     and p_to = 'resolving_auth_user')
       or (v_ob.state = 'resolving_auth_user' and p_to = 'linking_profile')) then
    raise exception 'invalid_state_transition';
  end if;

  update public.company_onboarding set state = p_to, updated_at = now()
    where id = v_ob.id returning * into v_ob;
  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 7) lookup_onboarding_email (bound to an onboarding id) ----------------
-- Exact-email classification, NOT a general email lookup. Returns only
-- auth_user_id + classification. Derives the email from the onboarding row.
create or replace function public.lookup_onboarding_email(p_onboarding uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_ob public.company_onboarding; v_uid uuid; v_class text;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  select * into v_ob from public.company_onboarding where id = p_onboarding for update;
  if not found then raise exception 'invalid_input'; end if;

  select c.auth_user_id, c.classification into v_uid, v_class
    from app.onboarding_classify(v_ob) c;

  return jsonb_build_object('auth_user_id', v_uid, 'classification', v_class);
end;
$$;

-- ---- 8) link_first_company_admin ------------------------------------------
-- Links/adopts the resolved Auth user as the first Company Admin. Enforces the
-- existing-email matrix. Does NOT claim any email was sent. Sets admin_linked.
-- p_created_by_us MUST be true only for a confirmed newly-created Auth user.
create or replace function public.link_first_company_admin(
  p_onboarding uuid, p_auth_user_id uuid, p_created_by_us boolean)
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
    -- Already the admin of this company (e.g. resumed after a lost response).
    update public.company_onboarding
       set auth_user_id = p_auth_user_id, state = 'admin_linked', updated_at = now()
     where id = v_ob.id returning * into v_ob;
    return app.onboarding_status_json(v_ob);
  end if;

  if v_class <> 'unlinked_inactive' then
    -- is_app_admin / linked_other_company / active_other_role: reject. We raise
    -- (rolling back this call's writes); the orchestrator records the terminal
    -- failure + audit via fail_company_onboarding(..., terminal := true), so the
    -- failure state survives in its own committed transaction.
    raise exception 'email_already_linked';
  end if;

  -- Link the fully-unlinked, inactive profile as this company's admin, via the
  -- narrow onboarding profile-link marker (see app.protect_profile_fields). The
  -- App Admin's auth.uid() is retained throughout.
  perform set_config('app.onboarding_profile_link', 'on', true);
  update public.profiles
     set company_id = v_ob.company_id, role = 'admin', active = true, updated_at = now()
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
          jsonb_build_object('onboarding_id', v_ob.id, 'new_state', 'admin_linked'));

  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 9) complete_company_onboarding ---------------------------------------
-- Activates the company ONLY after fully verifying the linked active admin.
create or replace function public.complete_company_onboarding(p_onboarding uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor uuid := auth.uid();
  v_ob    public.company_onboarding;
  v_co    public.companies;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  select * into v_ob from public.company_onboarding where id = p_onboarding for update;
  if not found then raise exception 'invalid_input'; end if;
  if v_ob.state = 'completed' then return app.onboarding_status_json(v_ob); end if;   -- idempotent
  if v_ob.state <> 'admin_linked' then raise exception 'invalid_state_transition'; end if;

  select * into v_co from public.companies where id = v_ob.company_id for update;

  -- Verification gate: the admin must be fully linked + active + clean, and the
  -- company must still be pending_setup.
  if not app.onboarding_admin_linked_ok(v_ob) or v_co.status <> 'pending_setup' then
    raise exception 'retry_required';
  end if;

  -- Activate via the Migration 23 lifecycle marker (the lifecycle-field guard
  -- otherwise blocks a direct status change).
  perform set_config('app.lifecycle_rpc', 'on', true);
  update public.companies set status = 'active' where id = v_ob.company_id;
  perform set_config('app.lifecycle_rpc', 'off', true);

  update public.company_onboarding
     set state = 'completed', completed_at = now(), updated_at = now()
   where id = v_ob.id returning * into v_ob;

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, target_user_id, details)
  values (v_actor, 'company_activated', v_ob.company_id, v_ob.auth_user_id,
          jsonb_build_object('onboarding_id', v_ob.id, 'prev_status', 'pending_setup', 'new_status', 'active'));

  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 10) fail / retry -----------------------------------------------------
create or replace function public.fail_company_onboarding(
  p_onboarding uuid, p_error_code text, p_terminal boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_actor uuid := auth.uid(); v_ob public.company_onboarding; v_new public.onboarding_state;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  select * into v_ob from public.company_onboarding where id = p_onboarding for update;
  if not found then raise exception 'invalid_input'; end if;
  if v_ob.state in ('completed', 'failed_terminal') then raise exception 'invalid_state_transition'; end if;

  v_new := case when coalesce(p_terminal, false) then 'failed_terminal'::public.onboarding_state
                else 'failed_retriable'::public.onboarding_state end;

  update public.company_onboarding
     set state = v_new, resume_from_state = v_ob.state,
         error_code = left(coalesce(p_error_code, 'onboarding_failed'), 64),
         updated_at = now()
   where id = v_ob.id returning * into v_ob;

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, details)
  values (v_actor, 'company_onboarding_failed', v_ob.company_id,
          jsonb_build_object('onboarding_id', v_ob.id, 'error_code', v_ob.error_code, 'new_state', v_new));

  return app.onboarding_status_json(v_ob);
end;
$$;

create or replace function public.retry_company_onboarding(p_onboarding uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_actor uuid := auth.uid(); v_ob public.company_onboarding;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  select * into v_ob from public.company_onboarding where id = p_onboarding for update;
  if not found then raise exception 'invalid_input'; end if;
  if v_ob.state <> 'failed_retriable' then raise exception 'invalid_state_transition'; end if;

  update public.company_onboarding
     set state = 'resolving_auth_user', attempt_count = attempt_count + 1,
         error_code = null, safe_error_message = null, updated_at = now()
   where id = v_ob.id returning * into v_ob;

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, details)
  values (v_actor, 'company_onboarding_retried', v_ob.company_id,
          jsonb_build_object('onboarding_id', v_ob.id, 'attempt_count', v_ob.attempt_count, 'new_state', 'resolving_auth_user'));

  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 11) record_admin_setup_email_result ----------------------------------
-- Records the OUTCOME OF AN EMAIL REQUEST (not proof of delivery). A successful
-- Auth API call is recorded as 'requested', never 'sent'/'delivered'.
create or replace function public.record_admin_setup_email_result(
  p_onboarding uuid, p_result_status public.setup_email_status,
  p_safe_error_code text, p_is_retry boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_actor uuid := auth.uid(); v_ob public.company_onboarding; v_action text;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  if p_result_status not in ('requested', 'failed', 'uncertain') then raise exception 'invalid_input'; end if;

  select * into v_ob from public.company_onboarding where id = p_onboarding for update;
  if not found then raise exception 'invalid_input'; end if;
  -- Setup-email operations are only valid once the admin is genuinely linked.
  if v_ob.state not in ('admin_linked', 'completed') or not app.onboarding_admin_linked_ok(v_ob) then
    raise exception 'admin_not_linked';
  end if;

  update public.company_onboarding
     set setup_email_status = p_result_status,
         setup_email_attempt_count = setup_email_attempt_count + 1,
         setup_email_requested_at = now(),
         setup_email_error_code = left(p_safe_error_code, 64),
         updated_at = now()
   where id = v_ob.id returning * into v_ob;

  v_action := case
    when coalesce(p_is_retry, false) then 'admin_setup_email_retried'
    when p_result_status = 'failed'  then 'admin_setup_email_failed'
    else 'admin_setup_email_requested' end;

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, target_user_id, details)
  values (v_actor, v_action, v_ob.company_id, v_ob.auth_user_id,
          jsonb_build_object('onboarding_id', v_ob.id, 'result', p_result_status,
                             'attempt_count', v_ob.setup_email_attempt_count));

  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 12) get_company_onboarding_status ------------------------------------
create or replace function public.get_company_onboarding_status(p_onboarding uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_ob public.company_onboarding;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  select * into v_ob from public.company_onboarding where id = p_onboarding;
  if not found then raise exception 'invalid_input'; end if;
  return app.onboarding_status_json(v_ob);
end;
$$;

-- ---- 12b) get_onboarding_setup_target -------------------------------------
-- Server-only helper for send-admin-setup-email: returns the onboarding's
-- normalized admin email so the Edge Function can send a recovery/setup email.
-- Bound to an onboarding id (never an arbitrary email). app_admin-gated. The
-- Edge Function uses this server-side and does NOT return the email to the
-- browser.
create or replace function public.get_onboarding_setup_target(p_onboarding uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_ob public.company_onboarding;
begin
  if not app.is_app_admin() then raise exception 'not_allowed'; end if;
  select * into v_ob from public.company_onboarding where id = p_onboarding;
  if not found then raise exception 'invalid_input'; end if;
  -- Only expose a setup-email target once the admin is genuinely linked.
  if v_ob.state not in ('admin_linked', 'completed') or not app.onboarding_admin_linked_ok(v_ob) then
    raise exception 'admin_not_linked';
  end if;
  return jsonb_build_object('admin_email_normalized', v_ob.admin_email_normalized);
end;
$$;

-- ---- 13) Grants -----------------------------------------------------------
-- Callable only by authenticated (the App Admin's forwarded JWT); never
-- public/anon. app.is_app_admin() inside each RPC is the real gate.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.begin_company_onboarding(uuid,text,text,text,text,text)',
    'public.advance_company_onboarding_state(uuid,public.onboarding_state)',
    'public.lookup_onboarding_email(uuid)',
    'public.link_first_company_admin(uuid,uuid,boolean)',
    'public.complete_company_onboarding(uuid)',
    'public.fail_company_onboarding(uuid,text,boolean)',
    'public.retry_company_onboarding(uuid)',
    'public.record_admin_setup_email_result(uuid,public.setup_email_status,text,boolean)',
    'public.get_company_onboarding_status(uuid)',
    'public.get_onboarding_setup_target(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon;', fn);
    execute format('grant execute on function %s to authenticated;', fn);
  end loop;
end $$;

revoke all on function app.onboarding_normalize(text,text,text,text,text) from public, anon;
revoke all on function app.onboarding_classify(public.company_onboarding) from public, anon;
revoke all on function app.onboarding_status_json(public.company_onboarding) from public, anon;
revoke all on function app.onboarding_admin_linked_ok(public.company_onboarding) from public, anon;
