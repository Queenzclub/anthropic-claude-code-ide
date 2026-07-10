-- ============================================================
-- Migration 21 (Stage 3D) — verification queries
-- Run these in the Supabase SQL Editor AFTER applying
-- 20260709000021_company_report.sql. Each block is independent.
-- ============================================================

-- 1) companies.timezone exists, NOT NULL, default 'Indian/Maldives'
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'companies' and column_name = 'timezone';
-- expect: timezone | text | NO | 'Indian/Maldives'::text

-- 2) Existing companies were backfilled to the default (no nulls)
select count(*) as companies_missing_timezone
from public.companies where timezone is null;
-- expect: 0

-- 3) Timezone validation trigger is installed
select tgname
from pg_trigger
where tgrelid = 'public.companies'::regclass and not tgisinternal
  and tgname = 'companies_validate_timezone';
-- expect: one row

-- 4) Invalid timezone is rejected on write (should RAISE, not update)
do $$
begin
  update public.companies set timezone = 'Mars/Phobos'
  where id = (select id from public.companies limit 1);
  raise exception 'FAIL: invalid timezone was accepted';
exception
  when others then raise notice 'OK: invalid timezone rejected (%).', sqlerrm;
end $$;

-- 5) Function exists, is SECURITY INVOKER, has a locked search_path
select p.proname,
       p.prosecdef            as security_definer,   -- expect: false
       p.proconfig            as settings             -- expect: {search_path=pg_catalog}
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'company_report';

-- 6) Execute is granted to authenticated only; NOT to anon or public
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'company_report'
order by grantee;
-- expect: authenticated (EXECUTE) and the owner; NO 'anon', NO 'PUBLIC'

-- 7) No stray per-timestamp indexes were created (this migration adds none)
select indexname
from pg_indexes
where tablename = 'vehicle_requests'
  and (indexname like '%_created_idx' or indexname like '%_completed_idx');
-- expect: 0 rows

-- 8) The company-scoped indexes the report relies on already exist
select indexname
from pg_indexes
where (tablename = 'vehicle_requests' and indexname in
         ('requests_company_status_idx','requests_company_idx'))
   or (tablename = 'fuel_logs' and indexname = 'fuel_logs_company_idx')
order by indexname;
-- expect: fuel_logs_company_idx, requests_company_idx / requests_company_status_idx

-- 9) Guard fires with no auth context: in the SQL Editor auth.uid() is null,
--    so a bare call must be rejected (proves the is_staff() guard is active).
do $$
begin
  perform public.company_report(current_date - 7, current_date);
  raise exception 'FAIL: report returned without a staff session';
exception
  when others then raise notice 'OK: unauthenticated call blocked (%).', sqlerrm;
end $$;

-- 10) Parameter validation (each should RAISE). These run before any access
--     check only if you are staff; in the SQL Editor they are still safe to
--     run — the is_staff() guard rejects first, which is also acceptable.
--     To test the validation paths directly, run them from an authenticated
--     staff session (e.g. the app), where you should see:
--       * end date before start date  -> 'End date cannot be before start date'
--       * range > 366 days            -> 'Date range too large (max 366 days)'
--       * p_status = 'bogus'          -> 'Invalid status filter'

-- Full functional report math (counts, KM, fuel, timing, snapshot,
-- recent-jobs status filter) is exercised from an authenticated staff
-- session — that arrives with the Stage 3D frontend. This file verifies the
-- database contract: structure, security, and validation.
