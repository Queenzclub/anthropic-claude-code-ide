-- ============================================================
-- Fleet Board Pro — Migration 21 (Stage 3D): daily / date-range reports
-- Run AFTER Migration 20.
--
-- Adds:
--   * companies.timezone (IANA, default 'Indian/Maldives') + a trigger
--     that rejects any zone not in pg_timezone_names, so date boundaries
--     are always computed against a valid zone.
--   * public.company_report(...) — ONE read-only, company-scoped report.
--     SECURITY INVOKER: RLS stays active as a second layer, and the
--     function additionally requires app.is_staff() + a valid
--     app.my_company_id() and filters every query by that company_id.
--     Driver/Outlet are rejected. company_id is NEVER a parameter.
--
-- Date handling: the caller passes p_start_date / p_end_date (end
-- inclusive). Boundaries are computed IN Postgres from the company's
-- stored timezone, so Today/Yesterday/custom stay correct regardless of
-- the viewer's device timezone. Max range 366 days.
--
-- Status filter (p_status) applies ONLY to the recent_jobs list, never to
-- the summary/rollups/snapshot (those stay full-spectrum by design).
--
-- No writes, no service_role, no cross-company path. No new indexes are
-- created: EXPLAIN on a 30k-row fixture shows the existing company-leading
-- indexes already serve every scan (see section 3 for the reasoning).
-- ============================================================

-- ---- 1) Company timezone + validation ----
alter table public.companies
  add column if not exists timezone text not null default 'Indian/Maldives';

create or replace function app.validate_company_timezone()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.timezone is null
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid timezone: %', new.timezone;
  end if;
  return new;
end;
$$;

drop trigger if exists companies_validate_timezone on public.companies;
create trigger companies_validate_timezone
  before insert or update on public.companies
  for each row execute function app.validate_company_timezone();

-- ---- 2) The report function ----
create or replace function public.company_report(
  p_start_date date,
  p_end_date   date,
  p_vehicle    uuid default null,
  p_driver     uuid default null,
  p_status     text default null
)
returns jsonb
language plpgsql
security invoker
stable
set search_path = pg_catalog
as $$
declare
  v_company uuid;
  v_tz      text;
  v_start   timestamptz;
  v_end     timestamptz;
  v_result  jsonb;
begin
  -- Access: staff of a valid company only (blocks Driver/Outlet/anon).
  if not app.is_staff() then
    raise exception 'Not allowed';
  end if;
  v_company := app.my_company_id();
  if v_company is null then
    raise exception 'Not allowed';
  end if;

  -- Parameter validation.
  if p_start_date is null or p_end_date is null then
    raise exception 'Start and end dates are required';
  end if;
  if p_end_date < p_start_date then
    raise exception 'End date cannot be before start date';
  end if;
  if (p_end_date - p_start_date) > 366 then
    raise exception 'Date range too large (max 366 days)';
  end if;
  if p_status is not null
     and p_status not in ('pending','accepted','in_progress','completed','cancelled') then
    raise exception 'Invalid status filter';
  end if;

  -- Company timezone (validated on write; defensive fallback).
  select timezone into v_tz from public.companies where id = v_company;
  if v_tz is null then v_tz := 'Indian/Maldives'; end if;

  -- Local date boundaries -> UTC instants; end date inclusive => [start, end).
  v_start := (p_start_date::timestamp) at time zone v_tz;
  v_end   := ((p_end_date + 1)::timestamp) at time zone v_tz;

  with
  base as (
    select r.*
    from public.vehicle_requests r
    where r.company_id = v_company
      and (p_vehicle is null or r.vehicle_id = p_vehicle)
      and (p_driver  is null or r.driver_id  = p_driver)
  ),
  created_r as (
    select count(*)::int c from base where created_at >= v_start and created_at < v_end
  ),
  accepted_r as (
    select count(*)::int c,
           avg(extract(epoch from (accepted_at - created_at)))
             filter (where created_at is not null and accepted_at >= created_at) a2a
    from base where accepted_at >= v_start and accepted_at < v_end
  ),
  started_r as (
    select avg(extract(epoch from (started_at - accepted_at)))
             filter (where accepted_at is not null and started_at >= accepted_at) a2s
    from base where started_at >= v_start and started_at < v_end
  ),
  completed_r as (
    select count(*)::int c,
           coalesce(sum(case when start_km is not null and end_km is not null and end_km >= start_km
                             then end_km - start_km else 0 end), 0) km,
           coalesce(sum(case when started_at is not null and completed_at >= started_at
                             then extract(epoch from (completed_at - started_at)) else 0 end), 0) run_s,
           avg(extract(epoch from (completed_at - started_at)))
             filter (where started_at is not null and completed_at >= started_at) avg_del
    from base where status = 'completed' and completed_at >= v_start and completed_at < v_end
  ),
  cancelled_r as (
    select count(*)::int c from base where status = 'cancelled' and cancelled_at >= v_start and cancelled_at < v_end
  ),
  fuel_r as (
    select coalesce(sum(liters),0) liters, coalesce(sum(cost),0) cost
    from public.fuel_logs f
    where f.company_id = v_company
      and f.filled_at >= v_start and f.filled_at < v_end
      and (p_vehicle is null or f.vehicle_id = p_vehicle)
      and (p_driver  is null or f.driver_id  = p_driver)
  ),
  -- Per-vehicle range rollups (from the already entity-filtered base).
  veh_jobs as (
    select vehicle_id,
      count(*) filter (where status='completed' and completed_at >= v_start and completed_at < v_end) completed,
      count(*) filter (where status='cancelled' and cancelled_at >= v_start and cancelled_at < v_end) cancelled,
      coalesce(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and start_km is not null and end_km is not null and end_km >= start_km
                        then end_km - start_km else 0 end),0) km,
      coalesce(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and started_at is not null and completed_at >= started_at
                        then extract(epoch from (completed_at - started_at)) else 0 end),0) run_s,
      avg(extract(epoch from (completed_at - started_at)))
        filter (where status='completed' and completed_at >= v_start and completed_at < v_end
                and started_at is not null and completed_at >= started_at) avg_del
    from base where vehicle_id is not null group by vehicle_id
  ),
  veh_fuel as (
    select vehicle_id, coalesce(sum(liters),0) liters, coalesce(sum(cost),0) cost
    from public.fuel_logs
    where company_id = v_company and filled_at >= v_start and filled_at < v_end
      and (p_driver is null or driver_id = p_driver)
    group by vehicle_id
  ),
  vehicles_arr as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.vehicle_name, 'plate', v.plate_number,
        'driver_name', dv.name, 'status', v.status, 'current_km', v.current_km,
        'completed', coalesce(vj.completed,0), 'cancelled', coalesce(vj.cancelled,0),
        'total_km', coalesce(vj.km,0), 'fuel_liters', coalesce(vf.liters,0), 'fuel_cost', coalesce(vf.cost,0),
        'run_seconds', coalesce(vj.run_s,0), 'avg_delivery_seconds', vj.avg_del
      ) order by v.vehicle_name), '[]'::jsonb) arr
    from public.vehicles v
    left join public.drivers dv on dv.id = v.driver_id
    left join veh_jobs vj on vj.vehicle_id = v.id
    left join veh_fuel vf on vf.vehicle_id = v.id
    where v.company_id = v_company and (p_vehicle is null or v.id = p_vehicle)
  ),
  -- Per-driver range rollups.
  drv_jobs as (
    select driver_id,
      count(*) filter (where accepted_at >= v_start and accepted_at < v_end) accepted,
      count(*) filter (where status='completed' and completed_at >= v_start and completed_at < v_end) completed,
      count(*) filter (where status='cancelled' and cancelled_at >= v_start and cancelled_at < v_end) cancelled,
      coalesce(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and start_km is not null and end_km is not null and end_km >= start_km
                        then end_km - start_km else 0 end),0) km,
      coalesce(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and started_at is not null and completed_at >= started_at
                        then extract(epoch from (completed_at - started_at)) else 0 end),0) run_s,
      avg(extract(epoch from (accepted_at - created_at)))
        filter (where accepted_at >= v_start and accepted_at < v_end and created_at is not null and accepted_at >= created_at) avg_resp,
      avg(extract(epoch from (completed_at - started_at)))
        filter (where status='completed' and completed_at >= v_start and completed_at < v_end
                and started_at is not null and completed_at >= started_at) avg_del
    from base where driver_id is not null group by driver_id
  ),
  drivers_arr as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'on_duty', d.on_duty, 'vehicle_name', vv.vehicle_name,
        'accepted', coalesce(dj.accepted,0), 'completed', coalesce(dj.completed,0), 'cancelled', coalesce(dj.cancelled,0),
        'total_km', coalesce(dj.km,0), 'run_seconds', coalesce(dj.run_s,0),
        'avg_response_seconds', dj.avg_resp, 'avg_delivery_seconds', dj.avg_del
      ) order by d.name), '[]'::jsonb) arr
    from public.drivers d
    left join drv_jobs dj on dj.driver_id = d.id
    left join lateral (
      select vehicle_name from public.vehicles
      where driver_id = d.id and active order by created_at limit 1
    ) vv on true
    where d.company_id = v_company and d.active and (p_driver is null or d.id = p_driver)
  ),
  -- Current snapshot (follows vehicle/driver filter; date never applies).
  snap_veh as (
    select
      count(*) filter (where status='available')   available,
      count(*) filter (where status='busy')        busy,
      count(*) filter (where status='offline')     offline,
      count(*) filter (where status='maintenance') maintenance,
      count(*) filter (where status='service_due') service_due,
      count(*) filter (where status='in_service')  in_service,
      count(*) filter (where status='damaged')     damaged
    from public.vehicles
    where company_id = v_company and active and (p_vehicle is null or id = p_vehicle)
  ),
  snap_open as (
    select
      count(*) filter (where status='pending')                    pending_now,
      count(*) filter (where status in ('accepted','in_progress')) active_now
    from public.vehicle_requests
    where company_id = v_company
      and (p_vehicle is null or vehicle_id = p_vehicle)
      and (p_driver  is null or driver_id  = p_driver)
  ),
  snap_duty as (
    select count(*)::int on_duty from public.drivers
    where company_id = v_company and active and on_duty and (p_driver is null or id = p_driver)
  ),
  -- Recent jobs: p_status applies HERE ONLY. Capped at 50.
  recent as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id, 'status', status, 'origin', origin, 'driver_name', driver_name,
        'vehicle', vehicle, 'plate', plate, 'start_km', start_km, 'end_km', end_km,
        'created_at', created_at, 'accepted_at', accepted_at, 'started_at', started_at,
        'completed_at', completed_at, 'cancelled_at', cancelled_at, 'duration_seconds', dur
      ) order by j_sort desc), '[]'::jsonb) arr
    from (
      select r.id, r.status, r.start_km, r.end_km, r.created_at, r.accepted_at, r.started_at,
             r.completed_at, r.cancelled_at,
             (case when r.outlet_id is not null then o.name else 'Manager request' end) origin,
             dr.name driver_name, vh.vehicle_name vehicle, vh.plate_number plate,
             (case when r.started_at is not null and r.completed_at >= r.started_at
                   then extract(epoch from (r.completed_at - r.started_at)) end) dur,
             coalesce(r.completed_at, r.cancelled_at, r.started_at, r.accepted_at, r.created_at) j_sort
      from base r
      left join public.outlets o  on o.id  = r.outlet_id
      left join public.drivers dr on dr.id = r.driver_id
      left join public.vehicles vh on vh.id = r.vehicle_id
      where (p_status is null or r.status::text = p_status)
        and (
             (r.created_at   >= v_start and r.created_at   < v_end)
          or (r.accepted_at  >= v_start and r.accepted_at  < v_end)
          or (r.completed_at >= v_start and r.completed_at < v_end)
          or (r.cancelled_at >= v_start and r.cancelled_at < v_end)
        )
      order by j_sort desc
      limit 50
    ) rj
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
        'start_date', p_start_date, 'end_date', p_end_date, 'timezone', v_tz,
        'start_utc', v_start, 'end_utc', v_end),
    'filters', jsonb_build_object('vehicle_id', p_vehicle, 'driver_id', p_driver, 'status', p_status),
    'summary', jsonb_build_object(
        'requests_created', (select c from created_r),
        'accepted',         (select c from accepted_r),
        'completed',        (select c from completed_r),
        'cancelled',        (select c from cancelled_r),
        'completion_rate',  (case when (select c from completed_r) + (select c from cancelled_r) > 0
                                  then round(((select c from completed_r)::numeric)
                                             / ((select c from completed_r) + (select c from cancelled_r)), 4)
                                  else null end),
        'total_km',         (select km from completed_r),
        'fuel_liters',      (select liters from fuel_r),
        'fuel_cost',        (select cost from fuel_r),
        'run_seconds',      (select run_s from completed_r),
        'avg_delivery_seconds',         (select avg_del from completed_r),
        'avg_request_to_accept_seconds',(select a2a from accepted_r),
        'avg_accepted_to_start_seconds',(select a2s from started_r)),
    'current_snapshot', jsonb_build_object(
        'pending_now',     (select pending_now from snap_open),
        'active_now',      (select active_now from snap_open),
        'drivers_on_duty', (select on_duty from snap_duty),
        'vehicles',        (select to_jsonb(snap_veh) from snap_veh)),
    'vehicles',    (select arr from vehicles_arr),
    'drivers',     (select arr from drivers_arr),
    'recent_jobs', (select arr from recent)
  ) into v_result;

  return v_result;
end;
$$;

revoke all     on function public.company_report(date, date, uuid, uuid, text) from public, anon;
grant  execute on function public.company_report(date, date, uuid, uuid, text) to authenticated;

-- ---- 3) Indexes ----
-- None. This was checked with EXPLAIN (ANALYZE) on a 30,007-row fixture,
-- examining ALL five request timestamp predicates (created_at, accepted_at,
-- started_at, completed_at, cancelled_at) plus fuel_logs.filled_at:
--
--   * The report's `base` CTE is referenced by 8 downstream CTEs, so
--     PostgreSQL MATERIALIZES it: vehicle_requests is scanned ONCE (by
--     company_id) and every timestamp filter runs against the in-memory
--     CTE result via "CTE Scan on base". No per-timestamp index on
--     vehicle_requests can be used by those aggregates — a dedicated
--     (company_id, created_at) / (company_id, completed_at) index was
--     built and measured: it was never chosen for a range and left RPC
--     latency unchanged (~2.8s vs ~2.8s), i.e. pure write overhead.
--   * The only direct vehicle_requests scans (base, snap_open) filter on
--     company_id equality, already served by the existing
--     requests_company_status_idx / requests_company_idx (company_id, status)
--     — confirmed on a selective company (0.6 ms index scan).
--   * fuel_r / veh_fuel filter (company_id, filled_at) as a range, already
--     served by the existing fuel_logs_company_idx (company_id, filled_at)
--     — confirmed both bounds used in the Index Cond (0.5 ms).
--
-- So no index is added here. (The report's cost is dominated by per-row
-- evaluation of the existing RLS USING clause during the company scan,
-- which is index-independent and out of scope for this migration.)
