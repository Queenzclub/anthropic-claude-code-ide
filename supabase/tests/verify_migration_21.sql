-- ============================================================
-- Migration 21 (Stage 3D) — verification queries
-- Run in the Supabase SQL Editor AFTER applying
-- 20260709000021_company_report.sql.
--
-- Parts A–C run as-is (no auth context needed).
-- Part D impersonates a staff user to exercise the report itself —
-- set :staff_uid to a real admin/manager profile.user_id first.
--
-- Every negative test runs the operation inside an INNER exception
-- handler and reports OK only when the EXPECTED error text appears; a
-- success, or the wrong error, is a FAIL. So removing a guard makes the
-- corresponding test FAIL rather than silently pass.
-- ============================================================

-- Reusable assertion helpers (dropped automatically at session end).
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

-- ---------- Part A: structure & security (run as-is) ----------

-- A1. companies.timezone: exists, NOT NULL, default 'Indian/Maldives'.
select 'A1 timezone column' as check, column_name, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='companies' and column_name='timezone';

-- A2. No company left without a timezone.
select 'A2 no null timezone' as check, count(*) as should_be_zero
from public.companies where timezone is null;

-- A3. Validation trigger installed.
select 'A3 tz trigger' as check, tgname
from pg_trigger where tgrelid='public.companies'::regclass and not tgisinternal
  and tgname='companies_validate_timezone';

-- A4. Function is SECURITY INVOKER with a locked search_path.
select 'A4 function security' as check,
       p.prosecdef as security_definer,      -- expect: f
       p.proconfig as settings                -- expect: {search_path=pg_catalog}
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='company_report';

-- A5. Execute granted to authenticated only (no anon / no PUBLIC).
select 'A5 grants' as check, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public' and routine_name='company_report'
order by grantee;

-- A6. The report's indexes exist (5 timestamp + 1 partial open + fuel range).
select 'A6 indexes' as check, indexname from pg_indexes
where (tablename='vehicle_requests' and indexname in (
         'requests_company_created_idx','requests_company_accepted_idx',
         'requests_company_started_idx','requests_company_completed_idx',
         'requests_company_cancelled_idx','requests_company_open_idx'))
   or (tablename='fuel_logs' and indexname='fuel_logs_company_idx')
order by indexname;   -- expect 7 rows

-- ---------- Part B: guard fires with no auth context ----------
-- In the SQL Editor auth.uid() is null, so a bare call must be rejected
-- (proves the is_staff() guard is active). This FAILS if the guard is removed.
select 'B1 unauth blocked' as check,
       pg_temp.expect_error($$select public.company_report(current_date-7, current_date)$$, 'Not allowed');

-- ---------- Part C: invalid timezone rejected on write ----------
select 'C1 bad tz rejected' as check,
       pg_temp.expect_error(
         $$update public.companies set timezone='Mars/Phobos'
           where id=(select id from public.companies limit 1)$$,
         'Invalid timezone');
select 'C2 good tz accepted' as check,
       pg_temp.expect_ok(
         $$update public.companies set timezone=timezone
           where id=(select id from public.companies limit 1)$$);

-- ============================================================
-- Part D: staff-context functional + isolation + outlet-access tests.
--
-- Requires a real staff (admin/manager) profile.user_id. Find one:
--     select user_id, role from public.profiles
--     where role in ('admin','manager') and active limit 5;
-- then paste it below and run Part D as one batch.
-- ============================================================
\set staff_uid '00000000-0000-0000-0000-000000000000'   -- <-- replace with a real staff user_id

set local role authenticated;
select set_config('request.jwt.claim.sub', :'staff_uid', true);

-- D1. Report runs for staff and returns the documented top-level shape.
select 'D1 report shape' as check,
       (select bool_and(j ? k) from unnest(array['range','filters','summary','current_snapshot','vehicles','drivers','recent_jobs']) k,
            lateral (select public.company_report(current_date-30, current_date) j) s) as all_keys_present;

-- D2. Staff sees ITS OWN outlet names in recent_jobs, and NEVER another
--     company's outlet name. Compares the origins returned against the
--     caller's own outlets (via RLS) — any origin that is a real outlet
--     name must belong to this company.
with rep as (select public.company_report(current_date-365, current_date) j),
     origins as (
       select distinct e->>'origin' o
       from rep, lateral jsonb_array_elements(j->'recent_jobs') e
       where e->>'origin' <> 'Manager request'
     )
select 'D2 outlet names are own-company only' as check,
       coalesce(bool_and(exists (select 1 from public.outlets o where o.name = origins.o)), true) as all_own
from origins;

-- D3. Validation boundaries (staff context, so validation is reached).
select 'D3 end<start'   as check, pg_temp.expect_error($$select public.company_report(current_date, current_date-1)$$, 'End date cannot be before start date');
select 'D4 366 accepted' as check, pg_temp.expect_ok($$select public.company_report(date '2026-01-01', date '2027-01-01')$$);
select 'D5 367 rejected' as check, pg_temp.expect_error($$select public.company_report(date '2026-01-01', date '2027-01-02')$$, 'Date range too large');
select 'D6 null dates'   as check, pg_temp.expect_error($$select public.company_report(null, current_date)$$, 'Start and end dates are required');
select 'D7 infinity'     as check, pg_temp.expect_error($$select public.company_report('-infinity'::date, 'infinity'::date)$$, 'finite');
select 'D8 bad status'   as check, pg_temp.expect_error($$select public.company_report(current_date-7, current_date, null, null, 'bogus')$$, 'Invalid status filter');

reset role;

-- D9 / D10. Driver and Outlet cannot execute the report. Replace the uids
--     with a real driver and outlet profile.user_id in this company.
-- \set driver_uid '...'
-- \set outlet_uid '...'
-- set local role authenticated; select set_config('request.jwt.claim.sub', :'driver_uid', true);
-- select 'D9 driver blocked' as check, pg_temp.expect_error($$select public.company_report(current_date-7,current_date)$$, 'Not allowed');
-- select set_config('request.jwt.claim.sub', :'outlet_uid', true);
-- select 'D10 outlet blocked' as check, pg_temp.expect_error($$select public.company_report(current_date-7,current_date)$$, 'Not allowed');
-- reset role;
