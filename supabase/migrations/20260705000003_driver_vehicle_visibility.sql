-- ============================================================
-- Fleet Board Pro — Migration 3: driver job vehicle visibility
-- Run AFTER the first two migrations.
--
-- Why: a manager can assign ANY available vehicle to a job, not
-- only the vehicle whose default driver_id matches the driver.
-- The driver needs to read that vehicle's name/plate to show it
-- on their job card. This policy lets a driver see a vehicle
-- exactly while they have an active (accepted/in_progress) job
-- on it — nothing more. Outlet users still see no vehicles.
-- ============================================================

create policy vehicles_select_active_job on public.vehicles
  for select to authenticated
  using (
    exists (
      select 1 from public.vehicle_requests r
      where r.vehicle_id = vehicles.id
        and r.driver_id = app.my_driver_id()
        and r.status in ('accepted', 'in_progress')
    )
  );
