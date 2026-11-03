-- Tabela de tarefas vindas do Slack + matriz de Eisenhower
create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id                 uuid primary key default gen_random_uuid(),

  -- origem no Slack
  slack_team_id      text,
  slack_channel_id   text not null,
  slack_ts           text not null,
  slack_user_id      text,
  slack_user_name    text,
  permalink          text,
  raw_text           text not null,

  -- extraído pela IA
  title              text not null,
  summary            text,
  due_date           date,
  urgency            smallint check (urgency between 1 and 5),
  importance         smallint check (importance between 1 and 5),
  suggested_quadrant text check (suggested_quadrant in ('q1','q2','q3','q4')),
  ai_reason          text,

  -- decisão sua (NULL = "Nova", ainda não atribuída)
  quadrant           text check (quadrant in ('q1','q2','q3','q4')),
  done               boolean not null default false,
  moved_at           timestamptz,

  created_at         timestamptz not null default now(),

  unique (slack_channel_id, slack_ts)   -- evita duplicatas quando o Slack reenvia eventos
);

create index if not exists tasks_quadrant_idx on public.tasks (quadrant, done, created_at desc);

-- Quem pode ver/editar o quadro (coloque seu e-mail aqui depois do deploy)
create table if not exists public.allowed_users (
  email text primary key
);

alter table public.tasks enable row level security;
alter table public.allowed_users enable row level security;

create or replace function public.is_allowed()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.allowed_users where email = auth.jwt() ->> 'email');
$$;

create policy "owner can read"   on public.tasks for select to authenticated using (public.is_allowed());
create policy "owner can update" on public.tasks for update to authenticated using (public.is_allowed()) with check (public.is_allowed());
create policy "owner can delete" on public.tasks for delete to authenticated using (public.is_allowed());
-- INSERT só pela Edge Function (service role, que ignora RLS)

-- Atualização em tempo real no site
alter publication supabase_realtime add table public.tasks;
