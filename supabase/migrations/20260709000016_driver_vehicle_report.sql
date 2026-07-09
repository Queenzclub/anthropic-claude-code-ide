-- ============================================================
-- Fleet Board Pro — Migration 16 (Stage 3A permissions):
-- driver vehicle-issue reporting
-- Run AFTER Migration 15.
--
-- Managers already can change vehicle service status: the migration-2
-- policy `vehicles_staff_update` covers admin AND manager, so their new
-- dashboard control needs no database change.
--
-- This migration adds ONLY the DRIVER path, kept deliberately narrow so
-- a driver can report a problem on their OWN linked vehicle and nothing
-- more:
--
--   * a driver may set status to 'service_due' or 'damaged' only;
--   * on their own linked vehicle only (app.my_vehicle_id(), which
--     resolves either link: profiles.vehicle_id or vehicles.driver_id);
--   * with an optional short issue note (new column vehicles.service_note);
--   * they may NOT set available/offline/maintenance/in_service/busy,
--     may NOT clear a manager-set unavailable state, and may NOT change
--     any identity column (name/plate/driver/company/active).
--
-- Company separation is unchanged and no service_role is used. The
-- driver's own location pings (which write last_lat/last_lng/last_updated
-- onto the vehicle through a SECURITY DEFINER trigger) are intentionally
-- NOT blocked — those columns are left editable so live tracking keeps
-- working.
-- ============================================================

-- ---- 1) Optional short issue note ----
alter table public.vehicles add column if not exists service_note text;

-- ---- 2) Let a driver SEE their own linked vehicle, regardless of which
--         link the admin used (default vehicle OR driver_id). Needed so
--         the driver dashboard can show the vehicle name/plate to report on.
create policy vehicles_select_own_link on public.vehicles
  for select to authenticated
  using (id = app.my_vehicle_id());

-- ---- 3) Let a driver UPDATE their own linked vehicle. The with-check
--         limits the resulting status to the two report states; the guard
--         trigger below limits WHICH columns/transitions are allowed.
create policy vehicles_update_own_driver on public.vehicles
  for update to authenticated
  using (
    app.my_role() = 'driver'
    and id = app.my_vehicle_id()
    and company_id = app.my_company_id()
  )
  with check (
    id = app.my_vehicle_id()
    and company_id = app.my_company_id()
    and status in ('service_due', 'damaged')
  );

-- ---- 4) Column + transition guard for driver reports ----
-- Staff and SQL-editor / service-role sessions pass straight through.
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
    -- Identity/ownership columns are off-limits to drivers. Location
    -- columns (last_lat/last_lng/last_updated) are intentionally allowed
    -- so the location-update trigger keeps working, and service_note is
    -- the driver's to set.
    if new.company_id     is distinct from old.company_id
       or new.vehicle_name is distinct from old.vehicle_name
       or new.plate_number is distinct from old.plate_number
       or new.driver_id    is distinct from old.driver_id
       or new.active       is distinct from old.active then
      raise exception 'Drivers can only report a vehicle issue';
    end if;

    if new.status is distinct from old.status then
      if new.status not in ('service_due', 'damaged') then
        raise exception 'Drivers can only mark a vehicle Service Due or Damaged';
      end if;
      -- A driver cannot override or clear a state only a manager/admin owns.
      if old.status in ('maintenance', 'in_service', 'damaged') then
        raise exception 'Only a manager or admin can change this vehicle''s service status';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger vehicles_driver_report_guard
  before update on public.vehicles
  for each row execute function app.protect_vehicle_driver_report();
