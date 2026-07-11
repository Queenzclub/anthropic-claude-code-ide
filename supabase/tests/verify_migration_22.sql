-- ============================================================
-- Migration 22 (Stage 3D corrections) — verification queries
-- Run in the Supabase SQL Editor AFTER applying
-- 20260709000022_company_report_corrections.sql.
--
-- Parts A–C run as-is (no auth context needed).
-- Part D impersonates a staff user to exercise the corrected report —
-- set :staff_uid to a real admin/manager profile.user_id first, and run
-- Part D as ONE batch (the transaction-local role/claim apply together).
--
-- Every negative test runs the operation inside an INNER exception
-- handler and reports OK only when the EXPECTED error text appears; a
-- success, or the wrong error, is a FAIL. Removing a guard makes the
-- corresponding test FAIL rather than silently pass.
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

-- ---------- Part A: structure & security (run as-is) ----------

-- A1. All six report indexes exist (5 lifecycle + 1 partial open).
select 'A1 six report indexes' as check, count(*) as should_be_6
from pg_indexes
where tablename='vehicle_requests' and indexname in (
  'requests_company_created_idx','requests_company_accepted_idx',
  'requests_company_started_idx','requests_company_completed_idx',
  'requests_company_cancelled_idx','requests_company_open_idx');

-- A1b. List them (and confirm the open one is PARTIAL).
select 'A1b index defs' as check, indexname,
       (indexdef like '%WHERE%') as is_partial
from pg_indexes
where tablename='vehicle_requests' and indexname in (
  'requests_company_created_idx','requests_company_accepted_idx',
  'requests_company_started_idx','requests_company_completed_idx',
  'requests_company_cancelled_idx','requests_company_open_idx')
order by indexname;

-- A2. company_report is SECURITY INVOKER with a locked search_path.
select 'A2 function security' as check,
       p.prosecdef as security_definer,      -- expect: f
       p.proconfig as settings                -- expect: {search_path=pg_catalog}
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='company_report';

-- A3. Execute granted to authenticated only (no anon / no PUBLIC).
select 'A3 grants' as check, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public' and routine_name='company_report'
order by grantee;

-- A4. companies.timezone still present (from Migration 21) + trigger.
select 'A4 timezone col' as check, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='companies' and column_name='timezone';
select 'A4b tz trigger' as check, tgname from pg_trigger
where tgrelid='public.companies'::regclass and not tgisinternal
  and tgname='companies_validate_timezone';

-- ---------- Part B: guard fires with no auth context ----------
-- In the SQL Editor auth.uid() is null, so a bare call must be rejected.
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
-- Part D: staff-context functional / isolation / filter tests.
-- Set :staff_uid to a real admin/manager profile.user_id:
--     select user_id, role from public.profiles
--     where role in ('admin','manager') and active limit 5;
-- Run Part D as ONE batch.
-- ============================================================
\set staff_uid '00000000-0000-0000-0000-000000000000'   -- <-- replace with a real staff user_id

set local role authenticated;
select set_config('request.jwt.claim.sub', :'staff_uid', true);

-- D1. Report runs for staff and returns the documented top-level shape.
select 'D1 report shape' as check,
       (select bool_and(j ? k)
          from unnest(array['range','filters','summary','current_snapshot','vehicles','drivers','recent_jobs']) k,
               lateral (select public.company_report(current_date-30, current_date) j) s) as all_keys_present;

-- D2. corrected 366-inclusive-day validation.
select 'D2 366 accepted' as check, pg_temp.expect_ok($$select public.company_report(date '2026-01-01', date '2027-01-01')$$);
select 'D3 367 rejected' as check, pg_temp.expect_error($$select public.company_report(date '2026-01-01', date '2027-01-02')$$, 'Date range too large');
select 'D4 end<start'    as check, pg_temp.expect_error($$select public.company_report(current_date, current_date-1)$$, 'End date cannot be before start date');
select 'D5 null dates'   as check, pg_temp.expect_error($$select public.company_report(null, current_date)$$, 'Start and end dates are required');
select 'D6 infinity'     as check, pg_temp.expect_error($$select public.company_report('-infinity'::date, 'infinity'::date)$$, 'finite');
select 'D7 bad status'   as check, pg_temp.expect_error($$select public.company_report(current_date-7, current_date, null, null, 'bogus')$$, 'Invalid status filter');

-- D8. Each vehicle/driver row carries an `active` flag (inactive-with-
--     activity are reportable). Confirms the corrected array shape.
select 'D8 vehicles carry active flag' as check,
       coalesce(bool_and(e ? 'active'), true) as ok
from lateral (select public.company_report(current_date-365, current_date) j) s,
     lateral jsonb_array_elements(s.j->'vehicles') e;
select 'D8b drivers carry active flag' as check,
       coalesce(bool_and(e ? 'active'), true) as ok
from lateral (select public.company_report(current_date-365, current_date) j) s,
     lateral jsonb_array_elements(s.j->'drivers') e;

-- D9. recent_jobs never leaks another company's outlet name: any origin
--     that matches a real outlet must be this company's own outlet.
with rep as (select public.company_report(current_date-365, current_date) j),
     origins as (select distinct e->>'origin' o from rep, lateral jsonb_array_elements(j->'recent_jobs') e
                 where e->>'origin' <> 'Manager request')
select 'D9 outlet names own-company only' as check,
       coalesce(bool_and(exists (select 1 from public.outlets o where o.name = origins.o)), true) as all_own
from origins;

-- D10. Recent Jobs Status filter affects ONLY recent_jobs, not the summary.
select 'D10 status filter scope' as check,
       ( (public.company_report(current_date-365, current_date)->'summary'->>'completed')
       = (public.company_report(current_date-365, current_date, null, null, 'cancelled')->'summary'->>'completed') )
       as summary_unchanged_by_status;

reset role;

-- D11 / D12. Driver and Outlet cannot execute the report. Replace with a
--     real driver and outlet profile.user_id in this company, then run:
-- set local role authenticated; select set_config('request.jwt.claim.sub', '<driver_uid>', true);
-- select 'D11 driver blocked' as check, pg_temp.expect_error($$select public.company_report(current_date-7,current_date)$$, 'Not allowed');
-- select set_config('request.jwt.claim.sub', '<outlet_uid>', true);
-- select 'D12 outlet blocked' as check, pg_temp.expect_error($$select public.company_report(current_date-7,current_date)$$, 'Not allowed');
-- reset role;
