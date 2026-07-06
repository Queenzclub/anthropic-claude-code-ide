-- ============================================================
-- Fleet Board Pro — Migration 8: outlet tracks its own delivery
-- Run AFTER the earlier migrations.
--
-- Lets outlet staff read a vehicle row ONLY while that vehicle is
-- on an active (accepted/in_progress) job for THEIR OWN outlet. This
-- exposes the vehicle's name/plate and mirrored last_lat/last_lng/
-- last_updated so the outlet can track the van bringing their own
-- delivery. Access appears only for their outlet's active jobs and
-- disappears the moment the job completes or is cancelled.
--
-- Strictly scoped: app.my_outlet_id() is the caller's own outlet, and
-- the request's outlet_id must equal it — so an outlet can never see
-- all company vehicles, other outlets' vehicles, or other companies'
-- vehicles. Driver rows and location_updates remain unreadable to
-- outlets; only the vehicle's mirrored position is exposed.
-- ============================================================

create policy vehicles_select_outlet_active_delivery on public.vehicles
  for select to authenticated
  using (
    exists (
      select 1 from public.vehicle_requests r
      where r.vehicle_id = vehicles.id
        and r.outlet_id = app.my_outlet_id()
        and r.status in ('accepted', 'in_progress')
    )
  );
