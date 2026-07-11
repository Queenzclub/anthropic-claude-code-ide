-- ============================================================
-- Fleet Board Pro — Migration 22 (Stage 3D): company_report corrections
-- Run AFTER Migration 21.
--
-- Corrective migration. An earlier build of Migration 21 was applied to
-- production; this migration converges that live state to the corrected
-- design (repo Migration 21 / commit 6ed488d). It is forward-only and
-- idempotent: it produces the same final state whether the earlier or the
-- corrected Migration 21 already ran.
--
-- What the earlier Migration 21 left in place and what this fixes:
--   * All-history `base` CTE (a Today/7-day report scanned lifetime
--     history)            -> single DATE-BOUNDED `win` working set.
--   * No range indexes     -> five (company_id,<timestamp>) lifecycle
--                             indexes + a partial open-jobs index.
--   * `> 366` range check   -> `> 365` (366 inclusive calendar days),
--                             plus rejection of non-finite dates.
--   * Entity filters ignored on parts of the snapshot/arrays
--                          -> vehicle/driver filters applied consistently
--                             to summary, rollups, snapshot AND arrays.
--   * Inactive drivers/vehicles dropped from history
--                          -> included when they have in-range activity,
--                             each row carrying an `active` flag.
--   * recent_jobs date match missed started_at
--                          -> started_at included (an in-progress job
--                             started in range appears).
--   * Durations as raw numeric -> clean whole seconds (bigint).
--
-- Unchanged and preserved: companies.timezone + its validation trigger
-- (added by Migration 21, identical here, so not re-created); SECURITY
-- INVOKER; locked search_path = pg_catalog; app.is_staff() +
-- app.my_company_id() guards; RLS stays active as the second layer;
-- company_id is never a caller parameter; execute limited to
-- authenticated (no anon/PUBLIC); no service_role. p_status still applies
-- ONLY to recent_jobs.
-- ============================================================

-- ---- 1) Range indexes ----
-- One (company_id, <timestamp>) index per lifecycle timestamp the window
-- can match on. The `win` working set is `company_id = X AND (created_at
-- in range OR accepted_at in range OR ... OR cancelled_at in range)`, which
-- the planner satisfies with a BitmapOr across these indexes for small
-- windows (large windows fall back to a single seq scan). All five are
-- load-bearing: dropping any one collapses the small-window BitmapOr into a
-- full-table seq scan. fuel_logs (company_id, filled_at) already exists
-- (Migration 20).
create index if not exists requests_company_created_idx   on public.vehicle_requests (company_id, created_at);
create index if not exists requests_company_accepted_idx  on public.vehicle_requests (company_id, accepted_at);
create index if not exists requests_company_started_idx   on public.vehicle_requests (company_id, started_at);
create index if not exists requests_company_completed_idx on public.vehicle_requests (company_id, completed_at);
create index if not exists requests_company_cancelled_idx on public.vehicle_requests (company_id, cancelled_at);

-- Current-snapshot open-jobs count (pending/active_now). A small PARTIAL
-- index over only open jobs, so counting them never scans completed
-- history — even for a company that owns most of the table (where the
-- planner would otherwise mis-cost the (company_id, status) index and
-- seq-scan). Open jobs are a naturally tiny, hot set.
create index if not exists requests_company_open_idx
  on public.vehicle_requests (company_id)
  where status in ('pending','accepted','in_progress');

-- ---- 2) Corrected report function (windowed architecture) ----
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
  if not isfinite(p_start_date) or not isfinite(p_end_date) then
    raise exception 'Dates must be finite calendar dates';
  end if;
  if p_end_date < p_start_date then
    raise exception 'End date cannot be before start date';
  end if;
  -- End date is inclusive, so a difference of 365 spans 366 calendar days.
  if (p_end_date - p_start_date) > 365 then
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
  -- ---- Single date-bounded working set: this company's requests whose
  -- ---- ANY lifecycle timestamp is in [v_start, v_end), entity-filtered.
  -- ---- Materialized so it is scanned ONCE and feeds every metric below.
  win as materialized (
    select r.id, r.status, r.vehicle_id, r.driver_id, r.outlet_id,
           r.start_km, r.end_km,
           r.created_at, r.accepted_at, r.started_at, r.completed_at, r.cancelled_at
    from public.vehicle_requests r
    where r.company_id = v_company
      and (p_vehicle is null or r.vehicle_id = p_vehicle)
      and (p_driver  is null or r.driver_id  = p_driver)
      and (
           (r.created_at   >= v_start and r.created_at   < v_end)
        or (r.accepted_at  >= v_start and r.accepted_at  < v_end)
        or (r.started_at   >= v_start and r.started_at   < v_end)
        or (r.completed_at >= v_start and r.completed_at < v_end)
        or (r.cancelled_at >= v_start and r.cancelled_at < v_end)
      )
  ),

  -- ---- Summary metrics (all from the one windowed pass) ----
  sums as (
    select
      count(*) filter (where created_at >= v_start and created_at < v_end)::int created,
      count(*) filter (where accepted_at >= v_start and accepted_at < v_end)::int accepted,
      count(*) filter (where status='completed' and completed_at >= v_start and completed_at < v_end)::int completed,
      count(*) filter (where status='cancelled' and cancelled_at >= v_start and cancelled_at < v_end)::int cancelled,
      coalesce(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and start_km is not null and end_km is not null and end_km >= start_km
                        then end_km - start_km else 0 end),0) km,
      coalesce(round(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and started_at is not null and completed_at >= started_at
                        then extract(epoch from (completed_at - started_at)) else 0 end)),0)::bigint run_s,
      round(avg(extract(epoch from (completed_at - started_at)))
        filter (where status='completed' and completed_at >= v_start and completed_at < v_end
                and started_at is not null and completed_at >= started_at))::bigint avg_del,
      round(avg(extract(epoch from (accepted_at - created_at)))
        filter (where accepted_at >= v_start and accepted_at < v_end
                and created_at is not null and accepted_at >= created_at))::bigint a2a,
      round(avg(extract(epoch from (started_at - accepted_at)))
        filter (where started_at >= v_start and started_at < v_end
                and accepted_at is not null and started_at >= accepted_at))::bigint a2s
    from win
  ),
  fuel_r as (
    select coalesce(sum(liters),0) liters, coalesce(sum(cost),0) cost
    from public.fuel_logs
    where company_id = v_company
      and (p_vehicle is null or vehicle_id = p_vehicle)
      and (p_driver  is null or driver_id  = p_driver)
      and filled_at >= v_start and filled_at < v_end
  ),

  -- ---- Per-vehicle range rollups (one grouped pass over win) ----
  veh_roll as (
    select vehicle_id,
      count(*) filter (where status='completed' and completed_at >= v_start and completed_at < v_end)::int completed,
      count(*) filter (where status='cancelled' and cancelled_at >= v_start and cancelled_at < v_end)::int cancelled,
      coalesce(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and start_km is not null and end_km is not null and end_km >= start_km
                        then end_km - start_km else 0 end),0) km,
      coalesce(round(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and started_at is not null and completed_at >= started_at
                        then extract(epoch from (completed_at - started_at)) else 0 end)),0)::bigint run_s,
      round(avg(extract(epoch from (completed_at - started_at)))
        filter (where status='completed' and completed_at >= v_start and completed_at < v_end
                and started_at is not null and completed_at >= started_at))::bigint avg_del
    from win where vehicle_id is not null group by vehicle_id
  ),
  veh_fuel as (
    select vehicle_id, coalesce(sum(liters),0) liters, coalesce(sum(cost),0) cost
    from public.fuel_logs
    where company_id = v_company and vehicle_id is not null
      and (p_vehicle is null or vehicle_id = p_vehicle)
      and (p_driver  is null or driver_id  = p_driver)
      and filled_at >= v_start and filled_at < v_end
    group by vehicle_id
  ),
  veh_used as (   -- vehicles with activity shown in the range
    select vehicle_id from veh_roll where completed > 0 or cancelled > 0
    union select vehicle_id from veh_fuel
  ),
  vehicles_arr as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.vehicle_name, 'plate', v.plate_number,
        'driver_name', dv.name, 'status', v.status, 'active', v.active, 'current_km', v.current_km,
        'completed', coalesce(vr.completed,0), 'cancelled', coalesce(vr.cancelled,0),
        'total_km', coalesce(vr.km,0), 'fuel_liters', coalesce(vf.liters,0), 'fuel_cost', coalesce(vf.cost,0),
        'run_seconds', coalesce(vr.run_s,0), 'avg_delivery_seconds', vr.avg_del
      ) order by v.vehicle_name), '[]'::jsonb) arr
    from public.vehicles v
    left join public.drivers dv on dv.id = v.driver_id
    left join veh_roll vr on vr.vehicle_id = v.id
    left join veh_fuel vf on vf.vehicle_id = v.id
    where v.company_id = v_company and (
      case
        when p_vehicle is not null and p_driver is not null
          then v.id = p_vehicle and (v.driver_id = p_driver or v.id in (select vehicle_id from veh_used))
        when p_vehicle is not null
          then v.id = p_vehicle
        when p_driver is not null
          then v.driver_id = p_driver or v.id in (select vehicle_id from veh_used)
        else
          v.active or v.id in (select vehicle_id from veh_used)
      end
    )
  ),

  -- ---- Per-driver range rollups (one grouped pass over win) ----
  drv_roll as (
    select driver_id,
      count(*) filter (where accepted_at >= v_start and accepted_at < v_end)::int accepted,
      count(*) filter (where status='completed' and completed_at >= v_start and completed_at < v_end)::int completed,
      count(*) filter (where status='cancelled' and cancelled_at >= v_start and cancelled_at < v_end)::int cancelled,
      coalesce(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and start_km is not null and end_km is not null and end_km >= start_km
                        then end_km - start_km else 0 end),0) km,
      coalesce(round(sum(case when status='completed' and completed_at >= v_start and completed_at < v_end
                        and started_at is not null and completed_at >= started_at
                        then extract(epoch from (completed_at - started_at)) else 0 end)),0)::bigint run_s,
      round(avg(extract(epoch from (accepted_at - created_at)))
        filter (where accepted_at >= v_start and accepted_at < v_end
                and created_at is not null and accepted_at >= created_at))::bigint avg_resp,
      round(avg(extract(epoch from (completed_at - started_at)))
        filter (where status='completed' and completed_at >= v_start and completed_at < v_end
                and started_at is not null and completed_at >= started_at))::bigint avg_del
    from win where driver_id is not null group by driver_id
  ),
  drv_used as (   -- drivers with activity shown in the range
    select driver_id from drv_roll where accepted > 0 or completed > 0 or cancelled > 0
  ),
  drivers_arr as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'active', d.active, 'on_duty', d.on_duty, 'vehicle_name', vv.vehicle_name,
        'accepted', coalesce(dr.accepted,0), 'completed', coalesce(dr.completed,0), 'cancelled', coalesce(dr.cancelled,0),
        'total_km', coalesce(dr.km,0), 'run_seconds', coalesce(dr.run_s,0),
        'avg_response_seconds', dr.avg_resp, 'avg_delivery_seconds', dr.avg_del
      ) order by d.name), '[]'::jsonb) arr
    from public.drivers d
    left join drv_roll dr on dr.driver_id = d.id
    left join lateral (
      select vehicle_name from public.vehicles
      where driver_id = d.id and active order by created_at limit 1
    ) vv on true
    where d.company_id = v_company and (
      case
        when p_driver is not null and p_vehicle is not null
          then d.id = p_driver and (
                 d.id in (select driver_id from public.vehicles where id = p_vehicle and company_id = v_company)
              or d.id in (select driver_id from drv_used))
        when p_driver is not null
          then d.id = p_driver
        when p_vehicle is not null
          then d.id in (select driver_id from public.vehicles where id = p_vehicle and company_id = v_company)
            or d.id in (select driver_id from drv_used)
        else
          d.active or d.id in (select driver_id from drv_used)
      end
    )
  ),

  -- ---- Current snapshot (no date; follows the entity filters; active-only) ----
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
    where company_id = v_company and active
      and (p_vehicle is null or id = p_vehicle)
      and (p_driver  is null or driver_id = p_driver)
  ),
  snap_open as (
    -- Only open statuses, so this uses the partial open-jobs index and
    -- never scans completed history.
    select
      count(*) filter (where status='pending')                     pending_now,
      count(*) filter (where status in ('accepted','in_progress'))  active_now
    from public.vehicle_requests
    where company_id = v_company
      and status in ('pending','accepted','in_progress')
      and (p_vehicle is null or vehicle_id = p_vehicle)
      and (p_driver  is null or driver_id  = p_driver)
  ),
  snap_duty as (
    select count(*)::int on_duty
    from public.drivers
    where company_id = v_company and active and on_duty
      and (p_driver is null or id = p_driver)
      and (p_vehicle is null
           or id = (select driver_id from public.vehicles where id = p_vehicle and company_id = v_company))
  ),

  -- ---- Recent jobs (from the same windowed set). p_status applies HERE
  -- ---- ONLY. Capped at 50. `win` already includes a job when ANY of its
  -- ---- five lifecycle timestamps is in range (started_at included, so an
  -- ---- in-progress job started in the window appears even if it was
  -- ---- created/accepted earlier). ----
  recent as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id, 'status', status, 'origin', origin, 'driver_name', driver_name,
        'vehicle', vehicle, 'plate', plate, 'start_km', start_km, 'end_km', end_km,
        'created_at', created_at, 'accepted_at', accepted_at, 'started_at', started_at,
        'completed_at', completed_at, 'cancelled_at', cancelled_at, 'duration_seconds', dur
      ) order by j_sort desc), '[]'::jsonb) arr
    from (
      select w.id, w.status, w.start_km, w.end_km, w.created_at, w.accepted_at, w.started_at,
             w.completed_at, w.cancelled_at,
             (case when w.outlet_id is not null then o.name else 'Manager request' end) origin,
             dr.name driver_name, vh.vehicle_name vehicle, vh.plate_number plate,
             (case when w.started_at is not null and w.completed_at >= w.started_at
                   then round(extract(epoch from (w.completed_at - w.started_at)))::bigint end) dur,
             coalesce(w.completed_at, w.cancelled_at, w.started_at, w.accepted_at, w.created_at) j_sort
      from win w
      left join public.outlets  o  on o.id  = w.outlet_id
      left join public.drivers  dr on dr.id = w.driver_id
      left join public.vehicles vh on vh.id = w.vehicle_id
      where (p_status is null or w.status::text = p_status)
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
        'requests_created', (select created from sums),
        'accepted',         (select accepted from sums),
        'completed',        (select completed from sums),
        'cancelled',        (select cancelled from sums),
        'completion_rate',  (case when (select completed from sums) + (select cancelled from sums) > 0
                                  then round(((select completed from sums)::numeric)
                                             / ((select completed from sums) + (select cancelled from sums)), 4)
                                  else null end),
        'total_km',         (select km from sums),
        'fuel_liters',      (select liters from fuel_r),
        'fuel_cost',        (select cost from fuel_r),
        'run_seconds',      (select run_s from sums),
        'avg_delivery_seconds',         (select avg_del from sums),
        'avg_request_to_accept_seconds',(select a2a from sums),
        'avg_accepted_to_start_seconds',(select a2s from sums)),
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

-- ---- 3) Re-affirm the grants (unchanged) ----
revoke all     on function public.company_report(date, date, uuid, uuid, text) from public, anon;
grant  execute on function public.company_report(date, date, uuid, uuid, text) to authenticated;
