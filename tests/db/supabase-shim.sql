-- TEST ONLY. Never applied to a real Supabase project.
--
-- Recreates the parts of a Supabase database that the migrations depend on,
-- so they can be tested on plain PostgreSQL 16 without the Supabase stack:
--   * the anon / authenticated / service_role API roles (service_role bypasses RLS)
--   * auth.users, auth.uid() and auth.jwt(), which read the request's JWT claims
--   * Supabase's broad default privileges on the public schema, so the tests
--     prove that our migrations revoke them rather than relying on a quiet default.
-- These mirror Supabase's documented behaviour as understood when written; they
-- were not checked against the current Supabase docs (supabase.com was not
-- reachable from the build environment).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

-- Supabase grants the API roles broad default access to new objects in public.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
