-- ============================================================
-- Migration 25 (Stage 4B security amendment) — verification (Supabase SQL Editor)
-- Run AFTER applying 20260712000024 AND 20260712000025_first_admin_setup.sql.
--
--   * Part A — structure & grants. Run as-is (as the postgres SQL-Editor role).
--   * Part B — behavior. Each block is BEGIN … ROLLBACK. Replace
--     REPLACE_APP_ADMIN_UUID with a real app_admin user_id first:
--         select user_id from public.profiles where role = 'app_admin';
--   * A NOTICE 'PASS …' is good; 'FAIL …' or any ERROR is not. Nothing is
--     persisted (every Part-B block rolls back).
--
-- Proof recap (evidence gathered against a local GoTrue v2.174.0 runtime):
--   invite/recovery sessions carry amr=[{method:"otp"}]; a fresh
--   signInWithPassword session carries amr=[{method:"password"}]. updateUser()
--   does NOT upgrade the held invite token's amr. So finalization requires a
--   genuine password session, proven from request.jwt.claims — NEVER from
--   auth.users.encrypted_password.
-- ============================================================


-- ================= Part A — structure & grants (run as-is) =================

select 'A1 new onboarding columns present' as check, count(*) as should_be_2
from information_schema.columns
where table_schema='public' and table_name='company_onboarding'
  and column_name in ('admin_setup_completed_at','setup_started_at');

select 'A2 finalization RPCs present' as check, count(*) as should_be_2
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('finalize_first_admin_setup','my_first_admin_setup_status');

select 'A3 finalize takes NO parameters (no id/role injection)' as check, pronargs as should_be_0
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='finalize_first_admin_setup';

select 'A4 amr proof helper present' as check, count(*) as should_be_1
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='app' and p.proname='request_has_password_amr';

select 'A5 finalize/setup-status granted to authenticated (not app_admin-only)' as check,
       string_agg(distinct grantee, ',' order by grantee) as grantees
from information_schema.role_routine_grants
where routine_schema='public'
  and routine_name in ('finalize_first_admin_setup','my_first_admin_setup_status')
  and grantee in ('authenticated','anon','public');
-- expect: authenticated  (never anon/public)

select 'A6 helpers revoked from anon/public' as check, count(*) as should_be_0
from information_schema.role_routine_grants
where routine_schema in ('public','app')
  and routine_name in ('finalize_first_admin_setup','my_first_admin_setup_status','request_has_password_amr')
  and grantee in ('anon','public');

select 'A7 protect_profile_fields carries the finalize marker path' as check,
       (pg_get_functiondef(p.oid) ilike '%app.first_admin_finalize%')::text as ok
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='app' and p.proname='protect_profile_fields';

select 'A8 onboarding_admin_linked_ok no longer requires active' as check,
       (pg_get_functiondef(p.oid) not ilike '%v_prof.active%')::text as ok
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='app' and p.proname='onboarding_admin_linked_ok';

select 'A9 status payload exposes setup milestones' as check,
       (pg_get_functiondef(p.oid) ilike '%admin_setup_completed_at%'
        and pg_get_functiondef(p.oid) ilike '%setup_started_at%')::text as ok
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='app' and p.proname='onboarding_status_json';


-- ================= Part B — behavior (BEGIN … ROLLBACK) =================

-- B1: the AMR proof helper — password=true, otp=false, missing=false.
begin;
do $$ declare a boolean; b boolean; c boolean; begin
  perform set_config('request.jwt.claims','{"amr":[{"method":"password"}]}', true); a := app.request_has_password_amr();
  perform set_config('request.jwt.claims','{"amr":[{"method":"otp"}]}', true);      b := app.request_has_password_amr();
  perform set_config('request.jwt.claims','{"sub":"x"}', true);                     c := app.request_has_password_amr();
  if a and not b and not c then raise notice 'PASS B1 amr proof: password=t, otp=f, missing=f';
  else raise notice 'FAIL B1 password=% otp=% missing=%',a,b,c; end if;
end $$;
rollback;

-- B2..B7: drive an onboarding to completed with an inactive first admin, then
-- exercise the finalization boundary. REPLACE_APP_ADMIN_UUID must be a real
-- active app_admin. The invited admin + its unlinked-inactive profile are
-- created inline.
begin;
do $$
declare
  v_app  uuid := 'REPLACE_APP_ADMIN_UUID';
  v_inv  uuid := gen_random_uuid();
  j jsonb; ob uuid; co uuid; tk uuid := gen_random_uuid(); act boolean; cid uuid;
begin
  -- Inline invited user: an unlinked, inactive profile (the adopt path).
  insert into auth.users (id, email) values (v_inv, 'verify25+'||v_inv||'@example.com');
  insert into public.profiles (user_id, company_id, role, name, email, active)
    values (v_inv, null, 'outlet', 'Invited', 'verify25+'||v_inv||'@example.com', false)
    on conflict (user_id) do update set company_id=null, role='outlet', active=false;

  perform set_config('request.jwt.claim.sub', v_app::text, true);
  j  := public.begin_company_onboarding(gen_random_uuid(),'Verify25 Co','VERIFY25','Indian/Maldives','Inv Admin', 'verify25+'||v_inv||'@example.com');
  ob := (j->>'onboarding_id')::uuid; co := (j->>'company_id')::uuid;
  perform public.claim_company_onboarding_processing(ob, tk);
  perform public.advance_company_onboarding_state(ob, 'resolving_auth_user', tk);
  perform public.advance_company_onboarding_state(ob, 'linking_profile', tk);
  perform public.link_first_company_admin(ob, v_inv, false, tk);
  perform public.complete_company_onboarding(ob, tk);

  -- B2: linked but inactive; company active.
  select active into act from public.profiles where user_id=v_inv;
  if act=false and (select status::text from public.companies where id=co)='active'
    then raise notice 'PASS B2 first admin linked INACTIVE, company active';
    else raise notice 'FAIL B2 active=%',act; end if;

  -- B3: inactive admin has no operational access.
  perform set_config('request.jwt.claim.sub', v_inv::text, true);
  if app.my_company_id() is null and app.my_role() is null
    then raise notice 'PASS B3 inactive first admin: operational helpers NULL';
    else raise notice 'FAIL B3 company=% role=%', app.my_company_id(), app.my_role(); end if;

  -- B4: setup status required + safe fields, no company_id leak.
  j := public.my_first_admin_setup_status();
  if (j->>'required')::boolean and (j ? 'company_id')=false and (j->>'admin_setup_completed_at') is null
    then raise notice 'PASS B4 setup status required, safe fields only';
    else raise notice 'FAIL B4 %',j; end if;

  -- B5: finalize with an otp (invite/recovery) session -> rejected.
  perform set_config('request.jwt.claims', json_build_object('sub',v_inv,'amr', json_build_array(json_build_object('method','otp')))::text, true);
  begin perform public.finalize_first_admin_setup(); raise notice 'FAIL B5 otp session finalized';
  exception when others then
    if sqlerrm='setup_proof_required' then raise notice 'PASS B5 otp session rejected (setup_proof_required)';
    else raise notice 'FAIL B5 %',sqlerrm; end if; end;

  -- B6: finalize with a password session -> activates once.
  perform set_config('request.jwt.claims', json_build_object('sub',v_inv,'amr', json_build_array(json_build_object('method','password')))::text, true);
  j := public.finalize_first_admin_setup();
  select active into act from public.profiles where user_id=v_inv;
  cid := app.my_company_id();
  if (j->>'finalized')::boolean and act and cid=co
    then raise notice 'PASS B6 password session finalized: profile active, access granted';
    else raise notice 'FAIL B6 j=% active=% company=%',j,act,cid; end if;

  -- B7: idempotent second call, completion audited exactly once.
  j := public.finalize_first_admin_setup();
  if (j->>'already_completed')::boolean
     and (select count(*) from public.platform_audit_log
          where action='first_company_admin_setup_completed' and target_user_id=v_inv)=1
    then raise notice 'PASS B7 finalize idempotent, completion audited once';
    else raise notice 'FAIL B7 %',j; end if;
end $$;
rollback;

-- B8: an unrelated user cannot finalize -> not_allowed.
begin;
do $$ declare v_other uuid := gen_random_uuid(); begin
  insert into auth.users (id, email) values (v_other, 'other25+'||v_other||'@example.com');
  perform set_config('request.jwt.claim.sub', v_other::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub',v_other,'amr', json_build_array(json_build_object('method','password')))::text, true);
  begin perform public.finalize_first_admin_setup(); raise notice 'FAIL B8 unrelated user finalized';
  exception when others then
    if sqlerrm='not_allowed' then raise notice 'PASS B8 unrelated user rejected (not_allowed)';
    else raise notice 'FAIL B8 %',sqlerrm; end if; end;
end $$;
rollback;
