create table if not exists articles (
  id text primary key,
  data jsonb not null,
  created_at timestamptz default now()
);
alter table articles enable row level security; -- build memakai service_role key, jadi tidak perlu policy publik
