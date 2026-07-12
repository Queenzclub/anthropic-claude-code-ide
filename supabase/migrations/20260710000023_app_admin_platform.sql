-- ============================================================
-- Fleet Board Pro — Migration 23 (Stage 4A): Super Admin / platform owner
-- Run AFTER Migration 22.
--
-- Adds the platform-owner role `app_admin`, company lifecycle
-- (pending_setup / active / suspended / archived), a central suspension
-- choke point, an append-only platform audit log, read-only app_admin
-- access, and protected lifecycle + platform-read RPCs.
--
-- SECURITY MODEL
--   * app_admin is NOT a company member (company_id IS NULL) and is NOT in
--     is_staff()/is_admin(), so it inherits none of the company powers.
--   * Suspension is enforced centrally: the four identity helpers
--     (my_company_id / my_driver_id / my_outlet_id / my_vehicle_id) return
--     NULL unless the caller's company status = 'active'. Every operational
--     RLS policy and cascading helper (i_am_on_duty / my_vehicle_dispatchable
--     / company_allows_driver_fuel / dispatchable_drivers / company_report)
--     keys on one of those four, so pending_setup/suspended/archived
--     companies are denied all reads AND writes with no per-policy edits.
--   * profiles_select_own stays (auth.uid based) so a blocked user can still
--     identify their account and sign out; my_account_access() gives that
--     user the minimal suspended-status payload.
--   * app_admin gets read-only SELECT policies; every lifecycle change goes
--     through a hardened SECURITY DEFINER RPC that writes the action + an
--     append-only audit row atomically. No app_admin INSERT/UPDATE/DELETE
--     policy on operational tables. No service_role anywhere.
--   * No create_company here (deferred to Stage 4B Edge Function). No hard
--     delete. This file contains no real user UUID/email — the first
--     app_admin is bootstrapped manually (see supabase/README / template).
-- ============================================================

-- ---- 1) New role + company status enum ----
alter type public.user_role add value if not exists 'app_admin';

do $$ begin
  if not exists (select 1 from pg_type where typname = 'company_status') then
    create type public.company_status as enum ('pending_setup', 'active', 'suspended', 'archived');
  end if;
end $$;

-- ---- 2) Company lifecycle columns ----
alter table public.companies
  add column if not exists status public.company_status not null default 'active',
  add column if not exists suspended_at     timestamptz,
  add column if not exists suspended_by     uuid references public.profiles (user_id),
  add column if not exists suspension_reason text,
  add column if not exists archived_at      timestamptz,
  add column if not exists archived_by      uuid references public.profiles (user_id);

-- Backfill: every existing company is active.
update public.companies set status = 'active' where status is null;

create index if not exists companies_status_idx on public.companies (status);

-- ---- 3) Keep the legacy boolean mirrored to status (status is the source
--         of truth; companies.active is deprecated). Never rely on the
--         frontend/RPCs alone to keep them in sync. ----
create or replace function app.sync_company_active()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.active := (new.status = 'active');
  return new;
end;
$$;

drop trigger if exists companies_sync_active on public.companies;
create trigger companies_sync_active
  before insert or update on public.companies
  for each row execute function app.sync_company_active();

-- Align existing rows now (fires the trigger).
update public.companies set status = status;

-- ---- 4) SUSPENSION CHOKE POINT: the four identity helpers resolve only
--         while the caller's company status = 'active'. app_admin (company
--         NULL) still resolves to NULL, exactly as before. ----
create or replace function app.my_company_id()
returns uuid language sql stable security definer set search_path = pg_catalog as $$
  select p.company_id
  from public.profiles p
  join public.companies c on c.id = p.company_id
  where p.user_id = auth.uid() and p.active and c.status = 'active';
$$;

create or replace function app.my_driver_id()
returns uuid language sql stable security definer set search_path = pg_catalog as $$
  select p.driver_id
  from public.profiles p
  join public.companies c on c.id = p.company_id
  where p.user_id = auth.uid() and p.active and c.status = 'active';
$$;

create or replace function app.my_outlet_id()
returns uuid language sql stable security definer set search_path = pg_catalog as $$
  select p.outlet_id
  from public.profiles p
  join public.companies c on c.id = p.company_id
  where p.user_id = auth.uid() and p.active and c.status = 'active';
$$;

create or replace function app.my_vehicle_id()
returns uuid language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(
    (select p.vehicle_id from public.profiles p
       join public.companies c on c.id = p.company_id
       where p.user_id = auth.uid() and p.active and c.status = 'active'),
    (select v.id from public.vehicles v
       where v.driver_id = app.my_driver_id() and v.active
       order by v.created_at limit 1));
$$;

-- ---- 5) app_admin identity ----
create or replace function app.is_app_admin()
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and active and role::text = 'app_admin');
$$;
grant execute on function app.is_app_admin() to authenticated;

-- ---- 5b) Company lifecycle-field guard ----
-- companies_admin_update (Migration 2) lets a Company Admin update its own
-- company row — including, without this guard, the lifecycle columns. This
-- BEFORE UPDATE trigger rejects any change to a lifecycle field unless it
-- comes through a trusted path:
--   (a) the SQL Editor / migration context (current_user='postgres' AND
--       session_user='postgres'); or
--   (b) inside an approved lifecycle RPC — proven by ALL of: a
--       transaction-local marker set by the RPC, the SECURITY DEFINER
--       execution context (current_user='postgres'), AND app.is_app_admin().
--       The marker alone is never sufficient (an ordinary caller can set the
--       GUC but can never be current_user='postgres' outside the definer RPC).
-- Legitimate company-settings updates (timezone, allow_driver_fuel_entry,
-- name, …) touch no lifecycle field and pass straight through. Rejects
-- Company Admin / Manager / Driver / Outlet / service_role / app_admin
-- direct DML. companies.status stays the source of truth; the guard runs
-- BEFORE companies_sync_active (name order: protect_lifecycle < sync_active
-- < updated_at < validate_timezone), so it evaluates the caller's raw intent
-- and the active mirror is applied afterwards.
create or replace function app.protect_company_lifecycle_fields()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_changed boolean;
  v_editor  boolean := (current_user = 'postgres' and session_user = 'postgres');
  v_rpc     boolean := (current_setting('app.lifecycle_rpc', true) = 'on'
                        and current_user = 'postgres'
                        and app.is_app_admin());
begin
  v_changed :=
       (new.status            is distinct from old.status)
    or (new.active            is distinct from old.active)
    or (new.suspended_at      is distinct from old.suspended_at)
    or (new.suspended_by      is distinct from old.suspended_by)
    or (new.suspension_reason is distinct from old.suspension_reason)
    or (new.archived_at       is distinct from old.archived_at)
    or (new.archived_by       is distinct from old.archived_by);

  if v_changed and not (v_editor or v_rpc) then
    raise exception 'Company lifecycle fields can only be changed through the lifecycle RPCs (suspend/reactivate/archive/restore)';
  end if;
  return new;
end;
$$;

drop trigger if exists companies_protect_lifecycle on public.companies;
create trigger companies_protect_lifecycle
  before update on public.companies
  for each row execute function app.protect_company_lifecycle_fields();

-- ---- 6) Role-escalation protection for app_admin ----
-- SECURITY INVOKER so current_user/session_user reflect the real caller.
-- ONLY the trusted manual context — the Supabase SQL Editor / migration
-- runner, which is the postgres LOGIN role (verified: current_user AND
-- session_user are both 'postgres') — may create, remove or edit an
-- app_admin profile. Nothing else qualifies: an existing active app_admin
-- is NOT allowed to change app_admin profiles by direct DML (runtime
-- grant/revoke of app_admin is reserved for a future explicitly-protected
-- RPC, which will add its own transaction-local marker when Stage 4B builds
-- it — mirroring the lifecycle-RPC design). This deliberately EXCLUDES
-- service_role (session_user='authenticator'), including a service_role
-- request carrying an app_admin's JWT subject, and every browser role
-- (authenticated/anon), including an authenticated app_admin. Ordinary
-- Company Admin/Manager/Driver/Outlet and self-service are blocked too.
-- Enforces the invariant that an app_admin profile has company_id IS NULL.
-- NEW trigger; protect_profile_fields is unchanged.
create or replace function app.protect_app_admin_role()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_trusted   boolean := (current_user = 'postgres' and session_user = 'postgres');
  v_involves  boolean;
begin
  -- Invariant: an app_admin profile must not belong to a company.
  if new.role::text = 'app_admin' and new.company_id is not null then
    raise exception 'app_admin profiles must have company_id null';
  end if;

  -- Does this write involve app_admin (assign to, remove from, or edit an
  -- app_admin row)?
  v_involves := (new.role::text = 'app_admin')
             or (tg_op = 'UPDATE' and old.role::text = 'app_admin');

  -- Only the trusted SQL-Editor / migration context may do so. is_app_admin()
  -- is intentionally NOT consulted here.
  if v_involves and not v_trusted then
    raise exception 'Not allowed to assign, remove, or modify an app_admin profile';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_protect_app_admin on public.profiles;
create trigger profiles_protect_app_admin
  before insert or update on public.profiles
  for each row execute function app.protect_app_admin_role();

-- ---- 7) Minimal self-status function for the suspended screen. Derives
--         everything from auth.uid(); never takes a company_id; exposes no
--         operational data and no other company. SECURITY DEFINER so a
--         blocked user (whose my_company_id() is now NULL) can still read
--         their own company's status. ----
create or replace function public.my_account_access()
returns jsonb
language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object(
    'user_id',            p.user_id,
    'role',               p.role,
    'active',             p.active,
    'company_id',         p.company_id,
    'company_name',       c.name,
    'company_status',     c.status,
    'suspension_reason',  case when c.status = 'suspended' then c.suspension_reason else null end,
    'operational_allowed',(p.active and p.company_id is not null and c.status = 'active')
  )
  from public.profiles p
  left join public.companies c on c.id = p.company_id
  where p.user_id = auth.uid();
$$;
revoke all     on function public.my_account_access() from public, anon;
grant  execute on function public.my_account_access() to authenticated;

-- ---- 8) Platform audit log (append-only) ----
create table if not exists public.platform_audit_log (
  id               uuid primary key default gen_random_uuid(),
  actor_user_id    uuid references public.profiles (user_id),  -- null only for trusted bootstrap
  action           text not null,
  target_company_id uuid references public.companies (id),
  target_user_id   uuid references public.profiles (user_id),
  details          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists platform_audit_company_idx on public.platform_audit_log (target_company_id, created_at desc);
create index if not exists platform_audit_created_idx on public.platform_audit_log (created_at desc);

alter table public.platform_audit_log enable row level security;
revoke all    on public.platform_audit_log from anon, authenticated;
-- SELECT privilege only; RLS (below) still limits rows to app_admin. No
-- INSERT/UPDATE/DELETE grant, so writes are privilege-denied for everyone —
-- rows are written solely by the SECURITY DEFINER RPCs (which run as owner).
grant  select on public.platform_audit_log to authenticated;

-- Only app_admin may read it. No INSERT/UPDATE/DELETE policy.
create policy platform_audit_select_appadmin on public.platform_audit_log
  for select to authenticated
  using (app.is_app_admin());

-- Immutability: reject any UPDATE/DELETE on audit rows.
create or replace function app.platform_audit_immutable()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'platform_audit_log is append-only';
end;
$$;
drop trigger if exists platform_audit_no_change on public.platform_audit_log;
create trigger platform_audit_no_change
  before update or delete on public.platform_audit_log
  for each row execute function app.platform_audit_immutable();

-- ---- 9) app_admin READ-ONLY policies (additive; existing company policies
--         are untouched). No write policies on operational tables. ----
create policy companies_select_appadmin        on public.companies        for select to authenticated using (app.is_app_admin());
create policy profiles_select_appadmin         on public.profiles         for select to authenticated using (app.is_app_admin());
create policy drivers_select_appadmin          on public.drivers          for select to authenticated using (app.is_app_admin());
create policy outlets_select_appadmin          on public.outlets          for select to authenticated using (app.is_app_admin());
create policy vehicles_select_appadmin         on public.vehicles         for select to authenticated using (app.is_app_admin());
create policy requests_select_appadmin         on public.vehicle_requests for select to authenticated using (app.is_app_admin());
create policy fuel_select_appadmin             on public.fuel_logs        for select to authenticated using (app.is_app_admin());

-- ---- 10) Protected lifecycle + platform-read RPCs ----
-- All require app.is_app_admin(); actor is derived from auth.uid(); every
-- reference is schema-qualified; search_path is locked; execute is granted
-- to authenticated only. Lifecycle writers are SECURITY DEFINER (they update
-- companies + append an audit row atomically). Reads are SECURITY INVOKER
-- (they run under the app_admin SELECT policies) but still hard-reject
-- non-app_admin callers.

-- suspend
create or replace function public.suspend_company(p_company uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare v_actor uuid := auth.uid(); v_row public.companies;
begin
  if not app.is_app_admin() then raise exception 'Not allowed'; end if;
  if p_company is null then raise exception 'A target company is required'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A suspension reason is required'; end if;
  -- Lock the row so concurrent lifecycle calls serialize on the same source state.
  select * into v_row from public.companies where id = p_company for update;
  if not found then raise exception 'Company not found'; end if;
  -- Transition: only an ACTIVE company can be suspended.
  if v_row.status <> 'active' then
    raise exception 'Only an active company can be suspended (current status: %)', v_row.status;
  end if;

  perform set_config('app.lifecycle_rpc', 'on', true);   -- authorize the lifecycle-field trigger
  update public.companies
     set status = 'suspended', suspended_at = now(), suspended_by = v_actor,
         suspension_reason = btrim(p_reason)
   where id = p_company;
  perform set_config('app.lifecycle_rpc', 'off', true);

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, details)
  values (v_actor, 'company_suspended', p_company,
          jsonb_build_object('prev_status', v_row.status, 'new_status', 'suspended', 'reason', btrim(p_reason)));

  return jsonb_build_object('id', p_company, 'status', 'suspended');
end;
$$;

-- reactivate (suspended -> active)
create or replace function public.reactivate_company(p_company uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare v_actor uuid := auth.uid(); v_row public.companies;
begin
  if not app.is_app_admin() then raise exception 'Not allowed'; end if;
  if p_company is null then raise exception 'A target company is required'; end if;
  select * into v_row from public.companies where id = p_company for update;
  if not found then raise exception 'Company not found'; end if;
  -- Transition: reactivate ONLY from suspended. archived uses
  -- restore_archived_company; pending_setup activation is reserved for the
  -- Stage 4B onboarding workflow and never happens here.
  if v_row.status <> 'suspended' then
    raise exception 'Only a suspended company can be reactivated (current status: %)', v_row.status;
  end if;

  perform set_config('app.lifecycle_rpc', 'on', true);
  update public.companies
     set status = 'active', suspended_at = null, suspended_by = null, suspension_reason = null
   where id = p_company;
  perform set_config('app.lifecycle_rpc', 'off', true);

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, details)
  values (v_actor, 'company_reactivated', p_company,
          jsonb_build_object('prev_status', v_row.status, 'new_status', 'active'));

  return jsonb_build_object('id', p_company, 'status', 'active');
end;
$$;

-- archive (reversible; requires reason)
create or replace function public.archive_company(p_company uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare v_actor uuid := auth.uid(); v_row public.companies;
begin
  if not app.is_app_admin() then raise exception 'Not allowed'; end if;
  if p_company is null then raise exception 'A target company is required'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'An archive reason is required'; end if;
  select * into v_row from public.companies where id = p_company for update;
  if not found then raise exception 'Company not found'; end if;
  -- Transition: archive ONLY from active or suspended (not already archived,
  -- not pending_setup).
  if v_row.status not in ('active', 'suspended') then
    raise exception 'Only an active or suspended company can be archived (current status: %)', v_row.status;
  end if;

  perform set_config('app.lifecycle_rpc', 'on', true);
  update public.companies
     set status = 'archived', archived_at = now(), archived_by = v_actor
   where id = p_company;
  perform set_config('app.lifecycle_rpc', 'off', true);

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, details)
  values (v_actor, 'company_archived', p_company,
          jsonb_build_object('prev_status', v_row.status, 'new_status', 'archived', 'reason', btrim(p_reason)));

  return jsonb_build_object('id', p_company, 'status', 'archived');
end;
$$;

-- restore (archived -> active)
create or replace function public.restore_archived_company(p_company uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare v_actor uuid := auth.uid(); v_row public.companies;
begin
  if not app.is_app_admin() then raise exception 'Not allowed'; end if;
  if p_company is null then raise exception 'A target company is required'; end if;
  select * into v_row from public.companies where id = p_company for update;
  if not found then raise exception 'Company not found'; end if;
  -- Transition: restore ONLY from archived.
  if v_row.status <> 'archived' then
    raise exception 'Only an archived company can be restored (current status: %)', v_row.status;
  end if;

  -- Restore to a clean active row. A company can be archived from either
  -- active OR suspended, so also clear any stale suspension metadata that
  -- was carried into the archived state — otherwise a restored company would
  -- look active while still holding a suspended_at/by/reason. The prior
  -- suspension and archive history stays preserved in platform_audit_log.
  perform set_config('app.lifecycle_rpc', 'on', true);
  update public.companies
     set status = 'active', archived_at = null, archived_by = null,
         suspended_at = null, suspended_by = null, suspension_reason = null
   where id = p_company;
  perform set_config('app.lifecycle_rpc', 'off', true);

  insert into public.platform_audit_log (actor_user_id, action, target_company_id, details)
  values (v_actor, 'company_restored', p_company,
          jsonb_build_object('prev_status', v_row.status, 'new_status', 'active'));

  return jsonb_build_object('id', p_company, 'status', 'active');
end;
$$;

-- platform overview (aggregate across all companies). SECURITY INVOKER +
-- app_admin SELECT policies. p_include_archived defaults false (archived are
-- hidden from the default company list).
create or replace function public.platform_overview(p_include_archived boolean default false)
returns jsonb language plpgsql security invoker stable set search_path = pg_catalog as $$
declare v_result jsonb;
begin
  if not app.is_app_admin() then raise exception 'Not allowed'; end if;

  with cos as (select * from public.companies),
  comp as (
    select
      count(*)                                                        total,          -- ALL companies (incl. archived)
      count(*) filter (where status <> 'archived')                    non_archived,
      count(*) filter (where status = 'active')                       active,
      count(*) filter (where status = 'suspended')                    suspended,
      count(*) filter (where status = 'pending_setup')                pending_setup,
      count(*) filter (where status = 'archived')                     archived
    from cos
  ),
  prof as (
    select
      count(*) filter (where role::text = 'admin')   company_admins,
      count(*) filter (where role::text = 'manager') managers
    from public.profiles where company_id is not null
  ),
  lists as (
    select
      (select count(*) from public.drivers)          drivers,
      (select count(*) from public.outlets)          outlets,
      (select count(*) from public.vehicles)         vehicles,
      (select count(*) from public.vehicle_requests) requests
  ),
  recent as (
    select coalesce(jsonb_agg(x order by created_at desc), '[]'::jsonb) arr from (
      select id, name, status, created_at from public.companies
      where p_include_archived or status <> 'archived'
      order by created_at desc limit 10
    ) x
  ),
  clist as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', id, 'name', name, 'status', status, 'timezone', timezone, 'created_at', created_at)
             order by name), '[]'::jsonb) arr
    from public.companies
    where p_include_archived or status <> 'archived'
  )
  select jsonb_build_object(
    'companies', jsonb_build_object(
        'total', (select total from comp),                 -- all, including archived
        'non_archived', (select non_archived from comp),
        'active', (select active from comp),
        'suspended', (select suspended from comp),
        'pending_setup', (select pending_setup from comp),
        'archived', (select archived from comp)),
    'totals', jsonb_build_object(
        'company_admins', (select company_admins from prof), 'managers', (select managers from prof),
        'drivers', (select drivers from lists), 'outlets', (select outlets from lists),
        'vehicles', (select vehicles from lists), 'requests', (select requests from lists)),
    'recent_companies', (select arr from recent),
    'company_list', (select arr from clist)
  ) into v_result;

  return v_result;
end;
$$;

-- company detail (read-only). SECURITY INVOKER + app_admin SELECT policies.
create or replace function public.company_detail(p_company uuid)
returns jsonb language plpgsql security invoker stable set search_path = pg_catalog as $$
declare v_result jsonb; v_row public.companies;
begin
  if not app.is_app_admin() then raise exception 'Not allowed'; end if;
  if p_company is null then raise exception 'A target company is required'; end if;
  select * into v_row from public.companies where id = p_company;
  if not found then raise exception 'Company not found'; end if;

  select jsonb_build_object(
    'company', jsonb_build_object(
        'id', v_row.id, 'name', v_row.name, 'code', v_row.code, 'status', v_row.status,
        'timezone', v_row.timezone, 'created_at', v_row.created_at,
        'suspended_at', v_row.suspended_at, 'suspension_reason', v_row.suspension_reason,
        'archived_at', v_row.archived_at,
        'allow_driver_fuel_entry', v_row.allow_driver_fuel_entry),
    -- Read-only lists (safe operational fields only; no email / auth secrets).
    'company_admins', (
      select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name, 'active', active) order by name), '[]'::jsonb)
      from public.profiles where company_id = p_company and role::text = 'admin'),
    'managers', (
      select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name, 'active', active) order by name), '[]'::jsonb)
      from public.profiles where company_id = p_company and role::text = 'manager'),
    'drivers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'name', d.name, 'active', d.active, 'on_duty', d.on_duty,
               'vehicle_name', vv.vehicle_name, 'vehicle_plate', vv.plate_number) order by d.name), '[]'::jsonb)
      from public.drivers d
      left join lateral (
        select vehicle_name, plate_number from public.vehicles
        where driver_id = d.id and active order by created_at limit 1
      ) vv on true
      where d.company_id = p_company),
    'outlets', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by name), '[]'::jsonb)
      from public.outlets where company_id = p_company),
    'vehicles', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', v.id, 'vehicle_name', v.vehicle_name, 'plate_number', v.plate_number,
               'status', v.status, 'current_km', v.current_km, 'active', v.active,
               'driver_name', dr.name) order by v.vehicle_name), '[]'::jsonb)
      from public.vehicles v
      left join public.drivers dr on dr.id = v.driver_id
      where v.company_id = p_company),
    'counts', jsonb_build_object(
        'drivers',  (select count(*) from public.drivers  where company_id = p_company),
        'outlets',  (select count(*) from public.outlets  where company_id = p_company),
        'vehicles', (select count(*) from public.vehicles where company_id = p_company),
        'requests', (select count(*) from public.vehicle_requests where company_id = p_company),
        'active_jobs', (select count(*) from public.vehicle_requests
                          where company_id = p_company and status in ('accepted','in_progress')),
        'fuel_logs', (select count(*) from public.fuel_logs where company_id = p_company),
        'km_readings', (select count(*) from public.vehicle_requests
                          where company_id = p_company and (start_km is not null or end_km is not null)))
  ) into v_result;

  return v_result;
end;
$$;

-- Grants: revoke from public/anon; grant to authenticated only.
revoke all on function public.suspend_company(uuid, text)          from public, anon;
revoke all on function public.reactivate_company(uuid)             from public, anon;
revoke all on function public.archive_company(uuid, text)          from public, anon;
revoke all on function public.restore_archived_company(uuid)       from public, anon;
revoke all on function public.platform_overview(boolean)           from public, anon;
revoke all on function public.company_detail(uuid)                 from public, anon;
grant execute on function public.suspend_company(uuid, text)        to authenticated;
grant execute on function public.reactivate_company(uuid)           to authenticated;
grant execute on function public.archive_company(uuid, text)        to authenticated;
grant execute on function public.restore_archived_company(uuid)     to authenticated;
grant execute on function public.platform_overview(boolean)         to authenticated;
grant execute on function public.company_detail(uuid)               to authenticated;
