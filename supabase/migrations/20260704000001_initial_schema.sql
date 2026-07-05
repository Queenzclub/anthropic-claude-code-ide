-- ============================================================
-- Fleet Board Pro — Migration 1: Initial schema
-- Tables, enums, indexes, triggers, and helper functions.
-- Run this FIRST, then 20260704000002_rls_policies.sql.
-- Safe to run in the Supabase SQL Editor.
-- ============================================================

-- ------------------------------------------------------------
-- Enums
-- ------------------------------------------------------------

create type public.user_role as enum ('admin', 'manager', 'outlet', 'driver');

create type public.vehicle_status as enum ('available', 'busy', 'offline', 'maintenance');

create type public.request_status as enum ('pending', 'accepted', 'in_progress', 'completed', 'cancelled');

-- ------------------------------------------------------------
-- Internal helper schema
-- Functions here are used by triggers and RLS policies.
-- ------------------------------------------------------------

create schema if not exists app;
grant usage on schema app to authenticated;

-- Keeps updated_at fresh on every row change.
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- companies
-- ------------------------------------------------------------

create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null unique,  -- e.g. GLOW2026, used when joining a company
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger companies_updated_at
  before update on public.companies
  for each row execute function app.set_updated_at();

-- ------------------------------------------------------------
-- outlets
-- ------------------------------------------------------------

create table public.outlets (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name       text not null,
  address    text,
  phone      text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index outlets_company_idx on public.outlets (company_id);

create trigger outlets_updated_at
  before update on public.outlets
  for each row execute function app.set_updated_at();

-- ------------------------------------------------------------
-- drivers
-- A driver is an operational record; the login account is linked
-- through profiles.driver_id (set by an admin).
-- ------------------------------------------------------------

create table public.drivers (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  name           text not null,
  phone          text,
  license_number text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index drivers_company_idx on public.drivers (company_id);

create trigger drivers_updated_at
  before update on public.drivers
  for each row execute function app.set_updated_at();

-- ------------------------------------------------------------
-- vehicles
-- ------------------------------------------------------------

create table public.vehicles (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  vehicle_name text not null,
  plate_number text not null,
  driver_id    uuid references public.drivers (id),  -- default/assigned driver
  status       public.vehicle_status not null default 'available',
  last_lat     double precision,
  last_lng     double precision,
  last_updated timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, plate_number)
);

create index vehicles_company_idx on public.vehicles (company_id);
create index vehicles_status_idx  on public.vehicles (company_id, status);

create trigger vehicles_updated_at
  before update on public.vehicles
  for each row execute function app.set_updated_at();

-- ------------------------------------------------------------
-- profiles
-- One row per auth user. New signups start inactive with no
-- company; an admin assigns company, role, and links.
-- ------------------------------------------------------------

create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  company_id uuid references public.companies (id),
  role       public.user_role not null default 'outlet',
  name       text,
  email      text,
  phone      text,
  outlet_id  uuid references public.outlets (id),   -- for outlet staff
  driver_id  uuid references public.drivers (id),   -- for driver users
  vehicle_id uuid references public.vehicles (id),  -- optional default vehicle
  active     boolean not null default false,        -- admin activates new users
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_company_idx on public.profiles (company_id);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function app.set_updated_at();

-- ------------------------------------------------------------
-- vehicle_requests (the jobs table)
-- ------------------------------------------------------------

create table public.vehicle_requests (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id),
  outlet_id           uuid not null references public.outlets (id),
  driver_id           uuid references public.drivers (id),
  vehicle_id          uuid references public.vehicles (id),
  status              public.request_status not null default 'pending',
  pickup_location     text not null,
  dropoff_location    text not null,
  customer_name       text,
  customer_contact    text,
  notes               text,
  requested_by        uuid not null references public.profiles (user_id),
  cancellation_reason text,
  accepted_at         timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index requests_company_idx on public.vehicle_requests (company_id, status);
create index requests_outlet_idx  on public.vehicle_requests (outlet_id);
create index requests_driver_idx  on public.vehicle_requests (driver_id);

-- Business rule: one active job per vehicle and per driver.
create unique index one_active_job_per_vehicle
  on public.vehicle_requests (vehicle_id)
  where status in ('accepted', 'in_progress') and vehicle_id is not null;

create unique index one_active_job_per_driver
  on public.vehicle_requests (driver_id)
  where status in ('accepted', 'in_progress') and driver_id is not null;

create trigger requests_updated_at
  before update on public.vehicle_requests
  for each row execute function app.set_updated_at();

-- ------------------------------------------------------------
-- location_updates
-- ------------------------------------------------------------

create table public.location_updates (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies (id),
  driver_id   uuid not null references public.drivers (id),
  vehicle_id  uuid references public.vehicles (id),
  lat         double precision not null,
  lng         double precision not null,
  recorded_at timestamptz not null default now()
);

create index locations_vehicle_idx on public.location_updates (vehicle_id, recorded_at desc);
create index locations_driver_idx  on public.location_updates (driver_id, recorded_at desc);

-- ------------------------------------------------------------
-- job_notes
-- ------------------------------------------------------------

create table public.job_notes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  request_id uuid not null references public.vehicle_requests (id) on delete cascade,
  author_id  uuid not null references public.profiles (user_id),
  note       text not null,
  created_at timestamptz not null default now()
);

create index job_notes_request_idx on public.job_notes (request_id);

-- ------------------------------------------------------------
-- delivery_proofs
-- proof_url should point at a Supabase Storage object, not a public URL.
-- ------------------------------------------------------------

create table public.delivery_proofs (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  request_id uuid not null references public.vehicle_requests (id) on delete cascade,
  driver_id  uuid not null references public.drivers (id),
  proof_url  text,
  note       text,
  created_at timestamptz not null default now()
);

create index delivery_proofs_request_idx on public.delivery_proofs (request_id);

-- ============================================================
-- Helper functions used by RLS policies and triggers.
-- SECURITY DEFINER lets them read profiles without recursion.
-- An inactive profile returns NULL everywhere, so every policy
-- check fails until an admin activates the user.
-- ============================================================

create or replace function app.my_company_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select company_id from public.profiles
  where user_id = auth.uid() and active;
$$;

create or replace function app.my_role()
returns public.user_role
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles
  where user_id = auth.uid() and active;
$$;

create or replace function app.my_outlet_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select outlet_id from public.profiles
  where user_id = auth.uid() and active;
$$;

create or replace function app.my_driver_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select driver_id from public.profiles
  where user_id = auth.uid() and active;
$$;

create or replace function app.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select app.my_role() = 'admin';
$$;

-- Admin or manager: the roles that run operations.
create or replace function app.is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select app.my_role() in ('admin', 'manager');
$$;

-- ============================================================
-- Trigger: create a profile automatically on signup.
-- New users are INACTIVE and have no company until an admin
-- assigns them — signup alone grants no access.
-- ============================================================

create or replace function app.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, name, email, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.email,
    false
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- ============================================================
-- Trigger: protect sensitive profile fields.
-- Only an admin may change role, company, active flag, or the
-- outlet/driver/vehicle links. Users can still edit their own
-- name and phone. Service-role/SQL-editor sessions (no auth.uid)
-- are allowed through for setup and fixes.
-- ============================================================

create or replace function app.protect_profile_fields()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
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

create trigger profiles_protect_fields
  before update on public.profiles
  for each row execute function app.protect_profile_fields();

-- ============================================================
-- Trigger: validate job status transitions and stamp times.
--
-- Allowed flow:   pending → accepted → in_progress → completed
-- Cancellation:   pending/accepted/in_progress → cancelled
--
-- Admin/manager may make any change (to fix mistakes).
-- Everyone else is limited to the forward flow above, and
-- closed jobs (completed/cancelled) cannot be edited.
-- ============================================================

create or replace function app.on_request_status_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then

    if auth.uid() is not null and not app.is_staff() then
      if old.status in ('completed', 'cancelled') then
        raise exception 'This job is closed and cannot be changed';
      end if;
      if not (
           (old.status = 'pending'     and new.status in ('accepted', 'cancelled'))
        or (old.status = 'accepted'    and new.status in ('in_progress', 'cancelled'))
        or (old.status = 'in_progress' and new.status in ('completed', 'cancelled'))
      ) then
        raise exception 'Invalid status change from % to %', old.status, new.status;
      end if;
    end if;

    if new.status = 'accepted'    then new.accepted_at  := coalesce(new.accepted_at,  now()); end if;
    if new.status = 'in_progress' then new.started_at   := coalesce(new.started_at,   now()); end if;
    if new.status = 'completed'   then new.completed_at := coalesce(new.completed_at, now()); end if;
    if new.status = 'cancelled'   then new.cancelled_at := coalesce(new.cancelled_at, now()); end if;
  end if;

  return new;
end;
$$;

create trigger requests_status_change
  before update on public.vehicle_requests
  for each row execute function app.on_request_status_change();

-- ============================================================
-- Trigger: keep vehicle status in sync with jobs.
--
--   job accepted / in_progress  → vehicle busy
--   job completed / cancelled   → vehicle back to available
--
-- A vehicle in maintenance is never touched, and a vehicle is
-- only released when it has no other active job. This is what
-- prevents vehicles getting stuck as busy.
-- ============================================================

create or replace function app.release_vehicle(p_vehicle_id uuid, p_skip_request uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.vehicles v
  set status = 'available'
  where v.id = p_vehicle_id
    and v.status = 'busy'
    and not exists (
      select 1 from public.vehicle_requests r
      where r.vehicle_id = v.id
        and r.id <> p_skip_request
        and r.status in ('accepted', 'in_progress')
    );
$$;

create or replace function app.sync_vehicle_status()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- Vehicle swapped or unassigned mid-job: free the old vehicle.
  if tg_op = 'UPDATE'
     and old.vehicle_id is not null
     and old.vehicle_id is distinct from new.vehicle_id then
    perform app.release_vehicle(old.vehicle_id, new.id);
  end if;

  if new.vehicle_id is not null then
    if new.status in ('accepted', 'in_progress') then
      update public.vehicles
      set status = 'busy'
      where id = new.vehicle_id
        and status <> 'maintenance';
    elsif new.status in ('completed', 'cancelled') then
      perform app.release_vehicle(new.vehicle_id, new.id);
    end if;
  end if;

  return new;
end;
$$;

create trigger requests_sync_vehicle
  after insert or update on public.vehicle_requests
  for each row execute function app.sync_vehicle_status();

-- ============================================================
-- Trigger: copy each location update onto the vehicle row so
-- dashboards read last_lat/last_lng/last_updated cheaply.
-- Freshness ("offline" display) is judged from last_updated in
-- the UI; the stored status is not flipped automatically.
-- ============================================================

create or replace function app.apply_location_update()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.vehicle_id is not null then
    update public.vehicles
    set last_lat = new.lat,
        last_lng = new.lng,
        last_updated = new.recorded_at
    where id = new.vehicle_id;
  end if;
  return new;
end;
$$;

create trigger locations_apply
  after insert on public.location_updates
  for each row execute function app.apply_location_update();
