-- Guarda o token do Slack obtido pelo fluxo OAuth da própria função.
-- Sem policies: só a Edge Function (service role) consegue ler/escrever.
create table if not exists public.slack_auth (
  id           smallint primary key default 1 check (id = 1), -- uma linha só
  user_id      text not null,
  team_id      text,
  access_token text not null,
  scopes       text,
  updated_at   timestamptz not null default now()
);

alter table public.slack_auth enable row level security;
