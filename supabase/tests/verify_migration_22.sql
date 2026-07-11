-- ============================================================
-- Migration 22 (Stage 3D corrections) — verification (Supabase SQL Editor)
-- Run AFTER applying 20260709000022_company_report_corrections.sql.
--
-- No psql-only syntax (no \set, no :'var'). Copy sections into the
-- Supabase SQL Editor and run them.
--
--   * Section 0 creates two assertion helpers — RUN IT FIRST (they persist
--     for the session).
--   * Parts A–C run as-is.
--   * Part D has four self-contained transaction blocks (Company Admin,
--     Manager, Driver rejection, Outlet rejection). Each block uses
--     SET LOCAL inside BEGIN … ROLLBACK, so it needs a real user UUID and
--     leaves NO role or data change behind.
--
-- Every negative test runs the operation inside an inner exception handler
-- and reports OK only when the EXPECTED error text appears; a success, or
-- the wrong error, is a FAIL. Removing a guard makes the test FAIL.
--
-- To find the UUIDs for Part D, run:
--     select user_id, role, name, active
--     from public.profiles
--     where active order by role;
-- Then paste:
--   * an  admin   user_id -> the Company Admin block
--   * a    manager user_id -> the Manager block
--   * a    driver  user_id -> the Driver-rejection block
--   * an   outlet  user_id -> the Outlet-rejection block
-- ============================================================


-- ============================================================
-- Section 0 — assertion helpers (RUN FIRST)
-- ============================================================
create or replace function pg_temp.expect_error(sql text, want_substr text)
returns text language plpgsql as $$
declare msg text;
begin
  begin
    execute sql;
  exception when others then
    msg := sqlerrm;
    if position(want_substr in msg) > 0 then return 'OK   ('||msg||')';
    else return 'FAIL (wrong error: '||msg||' | wanted: '||want_substr||')'; end if;
  end;
  return 'FAIL (no error raised; wanted: '||want_substr||')';
end $$;

create or replace function pg_temp.expect_ok(sql text)
returns text language plpgsql as $$
begin
  begin execute sql; exception when others then return 'FAIL (unexpected error: '||sqlerrm||')'; end;
  return 'OK';
end $$;


-- ============================================================
-- Part A — structure & security (run as-is)
-- ============================================================

-- A1. All six report indexes exist (5 lifecycle + 1 partial open).
select 'A1 six report indexes' as check, count(*) as should_be_6
from pg_indexes
where tablename='vehicle_requests' and indexname in (
  'requests_company_created_idx','requests_company_accepted_idx',
  'requests_company_started_idx','requests_company_completed_idx',
  'requests_company_cancelled_idx','requests_company_open_idx');

-- A1b. List them; the open one must be PARTIAL (is_partial = true).
select 'A1b index defs' as check, indexname, (indexdef like '%WHERE%') as is_partial
from pg_indexes
where tablename='vehicle_requests' and indexname in (
  'requests_company_created_idx','requests_company_accepted_idx',
  'requests_company_started_idx','requests_company_completed_idx',
  'requests_company_cancelled_idx','requests_company_open_idx')
order by indexname;

-- A2. company_report is SECURITY INVOKER (security_definer = f) with a
--     locked search_path ({search_path=pg_catalog}).
select 'A2 function security' as check, p.prosecdef as security_definer, p.proconfig as settings
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='company_report';

-- A3. Execute granted to authenticated only (no anon / no PUBLIC).
select 'A3 grants' as check, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public' and routine_name='company_report'
order by grantee;

-- A4. companies.timezone present (from Migration 21) + validation trigger.
select 'A4 timezone col' as check, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='companies' and column_name='timezone';
select 'A4b tz trigger' as check, tgname from pg_trigger
where tgrelid='public.companies'::regclass and not tgisinternal
  and tgname='companies_validate_timezone';


-- ============================================================
-- Part B — guard fires with no auth context (run as-is)
-- In the SQL Editor auth.uid() is null, so a bare call must be rejected.
-- ============================================================
select 'B1 unauthenticated blocked' as check,
       pg_temp.expect_error($$select public.company_report(current_date-7, current_date)$$, 'Not allowed');


-- ============================================================
-- Part C — invalid timezone rejected on write (run as-is)
-- Wrapped in a rolled-back transaction so it changes nothing.
-- ============================================================
begin;
select 'C1 bad tz rejected' as check,
       pg_temp.expect_error(
         $$update public.companies set timezone='Mars/Phobos'
           where id=(select id from public.companies limit 1)$$,
         'Invalid timezone');
select 'C2 good tz accepted' as check,
       pg_temp.expect_ok(
         $$update public.companies set timezone='Indian/Maldives'
           where id=(select id from public.companies limit 1)$$);
rollback;


-- ============================================================
-- Part D — staff-context tests. Each block is self-contained.
-- Replace the UUID literal, then run the whole block.
-- ============================================================

-- ---------- D-ADMIN: paste an ADMIN user_id ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_COMPANY_ADMIN_USER_UUID', true);

select label, result from (values
  -- report runs and returns the documented top-level shape
  ('D1 report shape',
     (select bool_and(j ? k)::text
        from unnest(array['range','filters','summary','current_snapshot','vehicles','drivers','recent_jobs']) k,
             lateral (select public.company_report(current_date-30, current_date) j) s)),
  -- 366-inclusive-day validation
  ('D2 366 accepted', pg_temp.expect_ok($$select public.company_report(date '2026-01-01', date '2027-01-01')$$)),
  ('D3 367 rejected', pg_temp.expect_error($$select public.company_report(date '2026-01-01', date '2027-01-02')$$, 'Date range too large')),
  ('D4 end<start',    pg_temp.expect_error($$select public.company_report(current_date, current_date-1)$$, 'End date cannot be before start date')),
  ('D5 null dates',   pg_temp.expect_error($$select public.company_report(null, current_date)$$, 'Start and end dates are required')),
  ('D6 infinity',     pg_temp.expect_error($$select public.company_report('-infinity'::date, 'infinity'::date)$$, 'finite')),
  ('D7 bad status',   pg_temp.expect_error($$select public.company_report(current_date-7, current_date, null, null, 'bogus')$$, 'Invalid status filter')),
  -- every vehicle/driver row carries an `active` flag (inactive-with-activity reportable)
  ('D8 vehicles carry active flag',
     (select coalesce(bool_and(e ? 'active'), true)::text
        from lateral (select public.company_report(current_date-365, current_date) j) s,
             lateral jsonb_array_elements(s.j->'vehicles') e)),
  ('D8b drivers carry active flag',
     (select coalesce(bool_and(e ? 'active'), true)::text
        from lateral (select public.company_report(current_date-365, current_date) j) s,
             lateral jsonb_array_elements(s.j->'drivers') e)),
  -- outlet names in recent_jobs are own-company only (no cross-company leak)
  ('D9 outlet names own-company only',
     (with rep as (select public.company_report(current_date-365, current_date) j),
           origins as (select distinct e->>'origin' o from rep, lateral jsonb_array_elements(j->'recent_jobs') e
                       where e->>'origin' <> 'Manager request')
      select coalesce(bool_and(exists (select 1 from public.outlets o where o.name = origins.o)), true)::text
      from origins)),
  -- Recent Jobs Status filter changes recent_jobs only, not the summary
  ('D10 status filter scope',
     ( (public.company_report(current_date-365, current_date)->'summary'->>'completed')
     = (public.company_report(current_date-365, current_date, null, null, 'cancelled')->'summary'->>'completed') )::text),
  -- REGRESSION (veh_used/drv_used fix): every driver/vehicle NAMED in
  -- recent_jobs (incl. in-progress-only jobs) is also present in the
  -- drivers[]/vehicles[] arrays. Fails if a used entity is omitted.
  ('D11 recent drivers reconcile to drivers[]',
     (with rep as (select public.company_report(current_date-365, current_date) j)
      select coalesce(bool_and(
               exists (select 1 from jsonb_array_elements(j->'drivers') d where d->>'name' = e->>'driver_name')
             ), true)::text
      from rep, lateral jsonb_array_elements(j->'recent_jobs') e
      where e->>'driver_name' is not null)),
  ('D12 recent vehicles reconcile to vehicles[]',
     (with rep as (select public.company_report(current_date-365, current_date) j)
      select coalesce(bool_and(
               exists (select 1 from jsonb_array_elements(j->'vehicles') v where v->>'name' = e->>'vehicle')
             ), true)::text
      from rep, lateral jsonb_array_elements(j->'recent_jobs') e
      where e->>'vehicle' is not null))
) t(label, result);

reset role;
rollback;


-- ---------- D-MANAGER: paste a MANAGER user_id (same checks as Admin) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_MANAGER_USER_UUID', true);

select label, result from (values
  ('M1 report shape',
     (select bool_and(j ? k)::text
        from unnest(array['range','filters','summary','current_snapshot','vehicles','drivers','recent_jobs']) k,
             lateral (select public.company_report(current_date-30, current_date) j) s)),
  ('M2 366 accepted', pg_temp.expect_ok($$select public.company_report(date '2026-01-01', date '2027-01-01')$$)),
  ('M3 367 rejected', pg_temp.expect_error($$select public.company_report(date '2026-01-01', date '2027-01-02')$$, 'Date range too large')),
  ('M4 status filter scope',
     ( (public.company_report(current_date-365, current_date)->'summary'->>'completed')
     = (public.company_report(current_date-365, current_date, null, null, 'cancelled')->'summary'->>'completed') )::text),
  ('M5 recent drivers reconcile to drivers[]',
     (with rep as (select public.company_report(current_date-365, current_date) j)
      select coalesce(bool_and(
               exists (select 1 from jsonb_array_elements(j->'drivers') d where d->>'name' = e->>'driver_name')
             ), true)::text
      from rep, lateral jsonb_array_elements(j->'recent_jobs') e
      where e->>'driver_name' is not null)),
  ('M6 recent vehicles reconcile to vehicles[]',
     (with rep as (select public.company_report(current_date-365, current_date) j)
      select coalesce(bool_and(
               exists (select 1 from jsonb_array_elements(j->'vehicles') v where v->>'name' = e->>'vehicle')
             ), true)::text
      from rep, lateral jsonb_array_elements(j->'recent_jobs') e
      where e->>'vehicle' is not null))
) t(label, result);

reset role;
rollback;


-- ---------- D-DRIVER: paste a DRIVER user_id (must be blocked) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_DRIVER_USER_UUID', true);
select 'D-DRIVER blocked' as check,
       pg_temp.expect_error($$select public.company_report(current_date-7, current_date)$$, 'Not allowed');
reset role;
rollback;


-- ---------- D-OUTLET: paste an OUTLET user_id (must be blocked) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_OUTLET_USER_UUID', true);
select 'D-OUTLET blocked' as check,
       pg_temp.expect_error($$select public.company_report(current_date-7, current_date)$$, 'Not allowed');
reset role;
rollback;
