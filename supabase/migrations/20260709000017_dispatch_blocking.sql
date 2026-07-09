-- ============================================================
-- Fleet Board Pro — Migration 17 (Stage 3A-2 Part A):
-- duty + vehicle-issue dispatch blocking
-- Run AFTER Migration 16.
--
-- Tightens DRIVER self-accept so it can never happen when the driver is
-- off duty or their vehicle is not fit for dispatch. Everything here is
-- RLS + trigger logic — no schema change, no service_role, company
-- separation untouched. Manager/admin assignment (the staff policies)
-- is unaffected, so they keep their override.
--
-- Rules enforced server-side (direct API calls included):
--   1. A driver may only SEE and ACCEPT a pending request when they are
--      ON DUTY and their linked vehicle is dispatchable — for BOTH open
--      and targeted requests (targeted no longer bypasses duty).
--   2. "Dispatchable" vehicle = linked, active, status in
--      (available, busy). So maintenance/in_service/damaged/service_due/
--      offline all block self-accept. A driver-reported issue flips the
--      vehicle to service_due/damaged, which therefore also stops NEW
--      accepts automatically — while existing accepted/in_progress jobs
--      stay visible and completable through the separate
--      requests_select_driver policy (unchanged).
--   3. A driver cannot go ON DUTY without a linked vehicle.
--   4. A driver cannot re-report / edit a vehicle that already has an
--      open issue (service_due/damaged/maintenance/in_service) — only a
--      manager/admin can clear it.
-- ============================================================

-- ---- 1) Is the calling driver's linked vehicle fit for dispatch? ----
create or replace function app.my_vehicle_dispatchable()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.vehicles v
    where v.id = app.my_vehicle_id()
      and v.active
      and v.status in ('available', 'busy')
  );
$$;

grant execute on function app.my_vehicle_dispatchable() to authenticated;

-- ---- 2) Driver dispatch inbox + self-accept now require on-duty AND a
--         dispatchable vehicle, for open AND targeted requests. ----
drop policy requests_select_driver_dispatch on public.vehicle_requests;
create policy requests_select_driver_dispatch on public.vehicle_requests
  for select to authenticated
  using (
    status = 'pending'
    and company_id = app.my_company_id()
    and app.my_role() = 'driver'
    and app.i_am_on_duty()
    and app.my_vehicle_dispatchable()
    and (dispatch_mode = 'open' or target_driver_id = app.my_driver_id())
  );

drop policy requests_driver_accept on public.vehicle_requests;
create policy requests_driver_accept on public.vehicle_requests
  for update to authenticated
  using (
    status = 'pending'
    and company_id = app.my_company_id()
    and app.my_role() = 'driver'
    and app.i_am_on_duty()
    and app.my_vehicle_dispatchable()
    and (dispatch_mode = 'open' or target_driver_id = app.my_driver_id())
  )
  with check (
    driver_id = app.my_driver_id()
    and status = 'accepted'
  );

-- ---- 3) A driver needs a linked vehicle before going on duty ----
-- Rebuilds the migration-12 guard and adds the vehicle requirement.
create or replace function app.protect_driver_fields()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or app.is_admin() then
    return new;
  end if;
  if new.company_id       is distinct from old.company_id
     or new.name           is distinct from old.name
     or new.phone          is distinct from old.phone
     or new.license_number is distinct from old.license_number
     or new.active         is distinct from old.active then
    raise exception 'Only an admin can change driver details';
  end if;
  if new.on_duty and not old.on_duty and app.my_vehicle_id() is null then
    raise exception 'Link a vehicle to your account before going on duty';
  end if;
  return new;
end;
$$;

-- ---- 4) One open issue at a time (adds service_due to the block, and
--         blocks note edits while flagged). Rebuilds the migration-16
--         guard; location columns stay editable so tracking still works.
create or replace function app.protect_vehicle_driver_report()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or app.is_staff() then
    return new;
  end if;

  if app.my_role() = 'driver' then
    if new.company_id     is distinct from old.company_id
       or new.vehicle_name is distinct from old.vehicle_name
       or new.plate_number is distinct from old.plate_number
       or new.driver_id    is distinct from old.driver_id
       or new.active       is distinct from old.active then
      raise exception 'Drivers can only report a vehicle issue';
    end if;

    -- Already flagged: only a manager/admin can change it now.
    if old.status in ('service_due', 'damaged', 'maintenance', 'in_service')
       and (new.status is distinct from old.status
            or new.service_note is distinct from old.service_note) then
      raise exception 'This vehicle already has an open issue. Manager or admin must clear it first';
    end if;

    if new.status is distinct from old.status
       and new.status not in ('service_due', 'damaged') then
      raise exception 'Drivers can only mark a vehicle Service Due or Damaged';
    end if;
  end if;

  return new;
end;
$$;
