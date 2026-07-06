-- ============================================================
-- Fleet Board Pro — Migration 9: dispatch + driver self-accept
-- Run AFTER the earlier migrations.
--
-- New flow: outlet/manager creates a request that is either OPEN
-- (any active company driver may accept) or SPECIFIC (targeted at
-- one driver). A driver accepts it from their own dashboard, which
-- assigns it to them. Manager assignment stays as an override.
--
-- Keeps company separation and the one-active-job rules. Does NOT
-- weaken RLS: the new policies only let a driver see and claim
-- pending, same-company, open/targeted-to-them requests.
-- ============================================================

-- ---- New columns on vehicle_requests ----
alter table public.vehicle_requests
  add column dispatch_mode text not null default 'open'
    check (dispatch_mode in ('specific', 'open')),
  add column target_vehicle_id uuid references public.vehicles (id),
  add column target_driver_id  uuid references public.drivers (id),
  -- Location foundation (optional map pins; UI comes in a later step).
  add column pickup_lat   double precision,
  add column pickup_lng   double precision,
  add column dropoff_lat  double precision,
  add column dropoff_lng  double precision;

-- Pending open/targeted requests are queried by drivers a lot.
create index requests_dispatch_idx
  on public.vehicle_requests (company_id, dispatch_mode)
  where status = 'pending';

-- ---- Helper: the vehicle assigned to the calling driver ----
create or replace function app.my_vehicle_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select id from public.vehicles
  where driver_id = app.my_driver_id() and active
  order by created_at
  limit 1;
$$;

grant execute on function app.my_vehicle_id() to authenticated;

-- ---- Let a driver CLAIM an unassigned request (null -> self) ----
-- Replaces the migration-4 body: ownership columns stay manager-only,
-- but a driver may claim driver_id / vehicle_id from NULL to their own
-- (that is how "accept" works). No reassigning an already-assigned job.
create or replace function app.protect_request_fields()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or app.is_staff() then
    return new;
  end if;

  if new.company_id      is distinct from old.company_id
     or new.outlet_id    is distinct from old.outlet_id
     or new.requested_by is distinct from old.requested_by then
    raise exception 'Only a manager or admin can change job assignment';
  end if;

  if new.driver_id is distinct from old.driver_id
     and not (old.driver_id is null and new.driver_id = app.my_driver_id()) then
    raise exception 'Only a manager or admin can change job assignment';
  end if;

  if new.vehicle_id is distinct from old.vehicle_id
     and not (old.vehicle_id is null and new.vehicle_id = app.my_vehicle_id()) then
    raise exception 'Only a manager or admin can change job assignment';
  end if;

  return new;
end;
$$;

-- ---- Driver can SEE pending requests dispatched to them ----
create policy requests_select_driver_dispatch on public.vehicle_requests
  for select to authenticated
  using (
    status = 'pending'
    and company_id = app.my_company_id()
    and app.my_role() = 'driver'
    and (dispatch_mode = 'open' or target_driver_id = app.my_driver_id())
  );

-- ---- Driver can ACCEPT (claim) such a request ----
-- USING selects the claimable pending rows; WITH CHECK forces the
-- driver to assign it to themselves and move it to 'accepted'. The
-- status trigger stamps accepted_at and the sync trigger marks the
-- vehicle busy. A second driver's accept matches zero rows (status is
-- no longer pending), so open requests can't be double-claimed.
create policy requests_driver_accept on public.vehicle_requests
  for update to authenticated
  using (
    status = 'pending'
    and company_id = app.my_company_id()
    and app.my_role() = 'driver'
    and (dispatch_mode = 'open' or target_driver_id = app.my_driver_id())
  )
  with check (
    driver_id = app.my_driver_id()
    and status = 'accepted'
  );
