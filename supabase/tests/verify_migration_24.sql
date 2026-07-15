-- ============================================================
-- Migration 24 (Stage 4B-1) — verification (Supabase SQL Editor)
-- Run AFTER applying 20260712000024_company_onboarding.sql.
--
--   * Part A — structure & grants. Run as-is (as the postgres SQL-Editor role).
--   * Part B — behavior. Each block is BEGIN … ROLLBACK and impersonates an
--     app_admin by setting request.jwt.claim.sub (app.is_app_admin() reads it).
--     Replace REPLACE_APP_ADMIN_UUID with a real app_admin user_id first:
--         select user_id from public.profiles where role = 'app_admin';
--   * A NOTICE 'PASS …' is good; 'FAIL …' or any ERROR is not. Nothing is
--     persisted (every Part-B block rolls back).
-- ============================================================


-- ================= Part A — structure & grants (run as-is) =================

select 'A1 onboarding_state values' as check,
       string_agg(e.enumlabel, ',' order by e.enumsortorder) as values
from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='onboarding_state';
-- expect: requested,company_created,resolving_auth_user,linking_profile,admin_linked,completed,failed_retriable,failed_terminal

select 'A1b setup_email_status values' as check,
       string_agg(e.enumlabel, ',' order by e.enumsortorder) as values
from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='setup_email_status';
-- expect: not_attempted,requested,failed,uncertain

select 'A2 company_onboarding key columns present' as check, count(*) as should_be_13
from information_schema.columns
where table_schema='public' and table_name='company_onboarding'
  and column_name in ('idempotency_key','request_fingerprint','requested_by','state',
      'resume_from_state','auth_user_id','auth_user_created_by_us','setup_email_status',
      'setup_email_attempt_count','setup_email_error_code',
      'processing_token','processing_started_at','processing_expires_at');

select 'A3 idempotency key is unique' as check, count(*) as should_be_1
from pg_indexes where schemaname='public' and tablename='company_onboarding'
  and indexdef ilike '%unique%' and indexdef ilike '%(idempotency_key)%';

select 'A3b one in-flight onboarding per email (partial unique)' as check, count(*) as should_be_1
from pg_indexes where schemaname='public' and tablename='company_onboarding'
  and indexname='company_onboarding_email_inflight_uidx';

select 'A4 onboarding RLS enabled' as check, relrowsecurity as ok
from pg_class where oid='public.company_onboarding'::regclass;
select 'A4b app_admin-only SELECT policy' as check, count(*) as should_be_1
from pg_policies where schemaname='public' and tablename='company_onboarding'
  and policyname='company_onboarding_select_appadmin';
select 'A4c authenticated grant on onboarding (SELECT only)' as check,
       string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema='public' and table_name='company_onboarding' and grantee='authenticated';

select 'A5 onboarding RPCs present' as check, count(*) as should_be_12
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'begin_company_onboarding','advance_company_onboarding_state','lookup_onboarding_email',
  'link_first_company_admin','complete_company_onboarding','fail_company_onboarding',
  'retry_company_onboarding','record_admin_setup_email_result','get_company_onboarding_status',
  'get_onboarding_setup_target','claim_company_onboarding_processing',
  'release_company_onboarding_processing');

select 'A5b locked search_path (expect {search_path=pg_catalog})' as check, p.proname, p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'begin_company_onboarding','lookup_onboarding_email','link_first_company_admin',
  'complete_company_onboarding','record_admin_setup_email_result')
order by p.proname;

select 'A6 RPC grants: authenticated only, no anon/public' as check, routine_name, grantee
from information_schema.routine_privileges
where routine_schema='public'
  and routine_name in ('begin_company_onboarding','lookup_onboarding_email','link_first_company_admin',
                       'complete_company_onboarding','record_admin_setup_email_result')
order by routine_name, grantee;

select 'A7 case-insensitive company-code unique index' as check, count(*) as should_be_1
from pg_indexes where schemaname='public' and tablename='companies' and indexname='companies_code_ci_uidx';
select 'A7b company-code format check constraint' as check, count(*) as should_be_1
from pg_constraint where conname='companies_code_format_chk';


-- ================= Part B — behavior (edit the UUID) =======================

-- ---------- B-AUTH: ordinary roles / no-context cannot begin ----------
begin;
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);   -- no user context
  begin perform public.begin_company_onboarding(gen_random_uuid(),'X','XCODE','UTC','n','x@x.co');
        raise exception 'FAIL: no-context began onboarding';
  exception when others then if sqlerrm <> 'not_allowed' then raise; end if; end;
  raise notice 'PASS B-AUTH: non-app_admin cannot begin onboarding';
end $$;
rollback;

-- ---------- B-BEGIN: idempotency + one company ----------
begin;
do $$
declare k uuid := gen_random_uuid(); j1 jsonb; j2 jsonb; n int;
begin
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  j1 := public.begin_company_onboarding(k,'Verify Co','VERIFY24','UTC','Vy','verify24@new.co');
  if j1->>'state' <> 'company_created' then raise exception 'FAIL: begin state %', j1; end if;
  j2 := public.begin_company_onboarding(k,'Verify Co','VERIFY24','UTC','Vy','verify24@new.co');  -- replay
  select count(*) into n from public.companies where code='VERIFY24';
  if j1->>'company_id' <> j2->>'company_id' or n <> 1 then raise exception 'FAIL: replay made a 2nd company (n=%)', n; end if;
  -- different payload, same key -> conflict
  begin perform public.begin_company_onboarding(k,'Verify Co CHANGED','VERIFY24','UTC','Vy','verify24@new.co');
        raise exception 'FAIL: conflicting replay accepted';
  exception when others then if sqlerrm <> 'idempotency_conflict' then raise; end if; end;
  raise notice 'PASS B-BEGIN: idempotent begin; replay resumes; conflict detected; one company';
end $$;
rollback;

-- ---------- B-MATRIX: existing email linked elsewhere is rejected ----------
begin;
do $$
declare j jsonb; ob uuid; co uuid; other uuid := gen_random_uuid(); othc uuid := gen_random_uuid(); tk uuid := gen_random_uuid();
begin
  -- Setup an existing user linked to ANOTHER company, as a trusted context
  -- (auth.uid() null is the profile-guard's sanctioned setup path).
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.companies (id,name,code,timezone,status,active) values (othc,'Other','OTHCODE24','UTC','active',true);
  insert into auth.users (id,email) values (other,'taken24@new.co');
  update public.profiles set company_id=othc, role='manager', active=true where user_id=other;
  -- now act as the app_admin
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  j := public.begin_company_onboarding(gen_random_uuid(),'Rej Co','REJ24','UTC','n','taken24@new.co');
  ob := (j->>'onboarding_id')::uuid;
  perform public.claim_company_onboarding_processing(ob, tk);
  if public.lookup_onboarding_email(ob)->>'classification' <> 'linked_other_company' then raise exception 'FAIL: classification'; end if;
  begin perform public.link_first_company_admin(ob, other, false, tk);
        raise exception 'FAIL: linked a user from another company';
  exception when others then if sqlerrm <> 'email_already_linked' then raise; end if; end;
  raise notice 'PASS B-MATRIX: email linked to another company -> email_already_linked';
end $$;
rollback;

-- ---------- B-HAPPY: new user -> link -> activate; gate + email separation --
begin;
do $$
declare j jsonb; ob uuid; co uuid; nu uuid := gen_random_uuid(); tk uuid := gen_random_uuid(); p public.profiles; c public.companies;
begin
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  j := public.begin_company_onboarding(gen_random_uuid(),'Happy Co','HAPPY24','UTC','Ha Admin','happy24@new.co');
  ob := (j->>'onboarding_id')::uuid; co := (j->>'company_id')::uuid;
  perform public.claim_company_onboarding_processing(ob, tk);
  -- activation is impossible before admin_linked
  begin perform public.complete_company_onboarding(ob, tk); raise exception 'FAIL: activated before link';
  exception when others then if sqlerrm <> 'invalid_state_transition' then raise; end if; end;
  -- simulate Auth invite creating the user (trigger makes an inactive outlet profile)
  insert into auth.users (id,email) values (nu,'happy24@new.co');
  j := public.link_first_company_admin(ob, nu, true, tk);
  if j->>'state' <> 'admin_linked' then raise exception 'FAIL: not admin_linked'; end if;
  -- link must NOT claim an email was sent
  if (j->>'setup_email_status') <> 'not_attempted' then raise exception 'FAIL: link touched email status'; end if;
  -- record a FAILED setup email; it must not block activation
  perform public.record_admin_setup_email_result(ob,'failed','smtp_down',false,tk);
  j := public.complete_company_onboarding(ob, tk);
  select * into c from public.companies where id=co;
  select * into p from public.profiles where user_id=nu;
  if j->>'state' <> 'completed' or c.status <> 'active'
     or p.role::text <> 'admin' or not p.active or p.company_id <> co then raise exception 'FAIL: activation state %', j; end if;
  if (j->>'setup_email_status') <> 'failed' then raise exception 'FAIL: email status lost'; end if;
  raise notice 'PASS B-HAPPY: no activation before link; new user linked; email failure did not block activation';
end $$;
rollback;

-- ---------- B-CODE-CI: case-equivalent company code is rejected ----------
begin;
do $$
declare j jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.companies (name, code, timezone, status, active) values ('Pre','CICODE','UTC','active',true);
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  begin perform public.begin_company_onboarding(gen_random_uuid(),'Clash','cicode','UTC','n','clash@ci.co');
        raise exception 'FAIL: case-equivalent code accepted';
  exception when others then if sqlerrm <> 'company_code_exists' then raise; end if; end;
  raise notice 'PASS B-CODE-CI: existing CICODE blocks onboarding cicode';
end $$;
rollback;

-- ---------- B-MARKER: authenticated App Admin direct profile DML is blocked ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare n int; target uuid;
begin
  select user_id into target from public.profiles where role <> 'app_admin' limit 1;
  -- Even if the app_admin sets the marker itself, RLS gives no UPDATE path.
  perform set_config('app.onboarding_profile_link', 'on', true);
  begin
    update public.profiles set role='admin' where user_id = target;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: authenticated app_admin changed a profile directly'; end if;
  exception when others then if position('Only an admin' in sqlerrm) = 0 then raise; end if; end;
  raise notice 'PASS B-MARKER: authenticated app_admin cannot use the marker for direct profile DML';
end $$;
reset role; rollback;

-- ---------- B-EMAIL-GATE: setup-email ops rejected before admin_linked ----------
begin;
do $$
declare j jsonb; ob uuid; tk uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  j := public.begin_company_onboarding(gen_random_uuid(),'Gate Co','GATE24','UTC','n','gate24@new.co');
  ob := (j->>'onboarding_id')::uuid;   -- state = company_created (no admin yet)
  perform public.claim_company_onboarding_processing(ob, tk);
  begin perform public.get_onboarding_setup_target(ob); raise exception 'FAIL: setup target before link';
  exception when others then if sqlerrm <> 'admin_not_linked' then raise; end if; end;
  begin perform public.record_admin_setup_email_result(ob,'requested',null,false,tk); raise exception 'FAIL: email result before link';
  exception when others then if sqlerrm <> 'admin_not_linked' then raise; end if; end;
  raise notice 'PASS B-EMAIL-GATE: setup-email target + record rejected before admin_linked';
end $$;
rollback;

-- ---------- B-LEASE: processing lease serializes executions ----------
begin;
do $$
declare j jsonb; ob uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  j := public.begin_company_onboarding(gen_random_uuid(),'Lease Co','LEASE24','UTC','n','lease24@new.co');
  ob := (j->>'onboarding_id')::uuid;
  perform public.claim_company_onboarding_processing(ob, t1);
  -- an active lease cannot be stolen
  begin perform public.claim_company_onboarding_processing(ob, t2); raise exception 'FAIL: lease stolen';
  exception when others then if sqlerrm <> 'onboarding_in_progress' then raise; end if; end;
  -- a wrong token cannot mutate state
  begin perform public.advance_company_onboarding_state(ob,'resolving_auth_user', t2); raise exception 'FAIL: wrong token advanced';
  exception when others then if sqlerrm <> 'onboarding_in_progress' then raise; end if; end;
  -- an expired lease is reclaimable (trusted context simulates expiry)
  perform set_config('request.jwt.claim.sub', '', true);
  update public.company_onboarding set processing_expires_at = now() - interval '1 second' where id = ob;
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  perform public.claim_company_onboarding_processing(ob, t2);
  raise notice 'PASS B-LEASE: active lease exclusive; wrong token blocked; expired lease reclaimable';
end $$;
rollback;

-- ---------- B-AUDIT: onboarding audit rows carry no secrets ----------
begin;
do $$
declare j jsonb; ob uuid; nu uuid := gen_random_uuid(); tk uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
  j := public.begin_company_onboarding(gen_random_uuid(),'Aud Co','AUDIT24','UTC','Au','audit24@new.co');
  ob := (j->>'onboarding_id')::uuid;
  perform public.claim_company_onboarding_processing(ob, tk);
  insert into auth.users (id,email) values (nu,'audit24@new.co');
  perform public.link_first_company_admin(ob, nu, true, tk);
  perform public.record_admin_setup_email_result(ob,'requested',null,false,tk);
  perform public.complete_company_onboarding(ob, tk);
  if exists (select 1 from public.platform_audit_log
             where (details->>'onboarding_id')::uuid = ob
               and details::text ~* '(password|secret|service_role|access_token|refresh_token|https?://)')
    then raise exception 'FAIL: secret-like content in onboarding audit';
    else raise notice 'PASS B-AUDIT: onboarding audit rows contain no secrets/links'; end if;
end $$;
rollback;
