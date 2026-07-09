-- ============================================================
-- Fleet Board Pro — Migration 14 (Stage 2B-3): multi-job queues
-- Run AFTER the earlier migrations.
--
-- One driver / one vehicle may now carry SEVERAL active deliveries.
--
-- The database was already multi-job correct everywhere else:
-- app.release_vehicle() only frees a vehicle when NO other
-- accepted/in_progress job references it, and protect_vehicle_status
-- blocks setting a vehicle available while any active job exists. The
-- only thing enforcing one-job-at-a-time was this pair of partial
-- unique indexes — retiring them IS the feature.
--
-- The replacement index keeps the vehicle-release lookup ("does this
-- vehicle have another active job?") fast: that query was previously
-- served by the unique index being dropped. Driver-side lookups are
-- already covered by requests_driver_status_idx (migration 10).
--
-- No RLS changes, no function changes, no data changes.
-- ============================================================

-- 1) Remove the one-active-job-at-a-time rules
drop index public.one_active_job_per_vehicle;
drop index public.one_active_job_per_driver;

-- 2) Replacement lookup index for the vehicle-release check
create index requests_active_by_vehicle
  on public.vehicle_requests (vehicle_id)
  where status in ('accepted', 'in_progress') and vehicle_id is not null;
