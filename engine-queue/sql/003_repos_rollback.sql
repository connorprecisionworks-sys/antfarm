-- Rollback for 003_repos.sql

drop policy if exists "read repos" on public.repos;
drop table if exists public.repos;
