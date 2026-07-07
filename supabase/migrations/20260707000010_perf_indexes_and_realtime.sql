-- ============================================================
-- Fleet Board Pro — Migration 10: performance indexes + realtime
-- Run AFTER the earlier migrations.
--
-- Two safe, additive changes. NO schema/column changes, NO RLS
-- changes, NO data changes.
--
-- 1) Indexes for the queries every dashboard runs constantly:
--    - manager: requests filtered by status (RLS adds company_id)
--    - outlet:  requests filtered by outlet_id + status
--    - driver:  requests filtered by driver_id + status
--    Existing rows are few today, but these keep the app fast as the
--    request history grows.
--
-- 2) Adds vehicle_requests to the Supabase Realtime publication so the
--    app can receive live INSERT/UPDATE events (new request created,
--    request completed). Realtime still enforces the SAME row-level
--    security that already exists, so a driver only receives open /
--    targeted requests in their company and an outlet only receives
--    its own requests. This does NOT weaken RLS.
-- ============================================================

-- ---- 1) Common-query indexes (idempotent) ----
create index if not exists requests_company_status_idx
  on public.vehicle_requests (company_id, status);

create index if not exists requests_outlet_status_idx
  on public.vehicle_requests (outlet_id, status);

create index if not exists requests_driver_status_idx
  on public.vehicle_requests (driver_id, status);

-- Location lookups by vehicle (manager map / outlet tracking mirror).
create index if not exists vehicles_company_active_idx
  on public.vehicles (company_id, active);

-- ---- 2) Realtime publication (idempotent + safe on plain Postgres) ----
-- Only runs on a Supabase database where the supabase_realtime
-- publication exists; skips silently on a local test Postgres.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'vehicle_requests'
     ) then
    alter publication supabase_realtime add table public.vehicle_requests;
  end if;
end $$;
