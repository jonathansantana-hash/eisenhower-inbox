-- =====================================================================
-- Multiusuário: cada pessoa vê só as próprias tarefas.
-- Acesso liberado para e-mails @hashtagtreinamentos.com (+ exceções em allowed_users).
-- =====================================================================

-- ---------- Quem pode usar ----------
create or replace function public.email_is_allowed(p_email text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(lower(p_email) like '%@hashtagtreinamentos.com', false)
      or exists (select 1 from public.allowed_users where lower(email) = lower(p_email));
$$;

create or replace function public.is_allowed()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.email_is_allowed(auth.jwt() ->> 'email');
$$;

-- Bloqueia a criação de contas fora do domínio (vale para e-mail e para "Entrar com Slack")
create or replace function public.check_signup_domain()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not public.email_is_allowed(new.email) then
    raise exception 'Acesso restrito a e-mails @hashtagtreinamentos.com';
  end if;
  return new;
end;
$$;

drop trigger if exists check_signup_domain on auth.users;
create trigger check_signup_domain
  before insert on auth.users
  for each row execute function public.check_signup_domain();

-- ---------- Dono das tarefas ----------
alter table public.tasks add column if not exists owner_id uuid references auth.users(id) on delete cascade;
update public.tasks
   set owner_id = (select id from auth.users where email = 'jonathan.santana@hashtagtreinamentos.com')
 where owner_id is null;
alter table public.tasks alter column owner_id set default auth.uid();
alter table public.tasks alter column owner_id set not null;

-- dedupe passa a ser por pessoa (a mesma mensagem pode virar tarefa para 2 pessoas mencionadas)
alter table public.tasks drop constraint if exists tasks_slack_channel_id_slack_ts_key;
create unique index if not exists tasks_owner_slack_msg_key on public.tasks (owner_id, slack_channel_id, slack_ts);
create index if not exists tasks_owner_idx on public.tasks (owner_id, created_at desc);

drop policy if exists "owner can read"   on public.tasks;
drop policy if exists "owner can update" on public.tasks;
drop policy if exists "owner can delete" on public.tasks;
drop policy if exists "owner can insert" on public.tasks;
create policy "own tasks: read"   on public.tasks for select to authenticated using (owner_id = auth.uid() and public.is_allowed());
create policy "own tasks: insert" on public.tasks for insert to authenticated with check (owner_id = auth.uid() and public.is_allowed());
create policy "own tasks: update" on public.tasks for update to authenticated using (owner_id = auth.uid() and public.is_allowed()) with check (owner_id = auth.uid());
create policy "own tasks: delete" on public.tasks for delete to authenticated using (owner_id = auth.uid() and public.is_allowed());

-- ---------- Conexão com o Slack (uma por pessoa) ----------
-- Sem policies: o token só é lido pela Edge Function (service role).
create table if not exists public.slack_connections (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  slack_user_id text not null unique,
  team_id       text,
  access_token  text not null,
  scopes        text,
  updated_at    timestamptz not null default now()
);
alter table public.slack_connections enable row level security;

insert into public.slack_connections (user_id, slack_user_id, team_id, access_token, scopes, updated_at)
select u.id, s.user_id, s.team_id, s.access_token, s.scopes, s.updated_at
  from public.slack_auth s
  join auth.users u on u.email = 'jonathan.santana@hashtagtreinamentos.com'
on conflict (user_id) do nothing;

-- O site só consegue ver SE está conectado (nunca o token)
create or replace function public.my_slack_connection()
returns table (slack_user_id text, team_id text, updated_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select slack_user_id, team_id, updated_at from public.slack_connections where user_id = auth.uid();
$$;

create or replace function public.disconnect_slack()
returns void
language sql security definer set search_path = public
as $$
  delete from public.slack_connections where user_id = auth.uid();
$$;

revoke all on function public.my_slack_connection() from public, anon;
revoke all on function public.disconnect_slack() from public, anon;
grant execute on function public.my_slack_connection() to authenticated;
grant execute on function public.disconnect_slack() to authenticated;

-- ---------- Preferências de cada pessoa ----------
create table if not exists public.user_settings (
  user_id            uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  watch_dms          boolean not null default true,
  watch_mentions     boolean not null default true,
  watch_channel_ids  text[]  not null default '{}',
  vip_user_ids       text[]  not null default '{}',
  important_keywords text[]  not null default '{}',
  updated_at         timestamptz not null default now()
);
alter table public.user_settings enable row level security;

drop policy if exists "own settings: read"   on public.user_settings;
drop policy if exists "own settings: insert" on public.user_settings;
drop policy if exists "own settings: update" on public.user_settings;
create policy "own settings: read"   on public.user_settings for select to authenticated using (user_id = auth.uid());
create policy "own settings: insert" on public.user_settings for insert to authenticated with check (user_id = auth.uid() and public.is_allowed());
create policy "own settings: update" on public.user_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
