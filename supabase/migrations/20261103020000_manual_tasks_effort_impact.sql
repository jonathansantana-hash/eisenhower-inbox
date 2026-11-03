-- 1) Tarefas manuais: campos do Slack passam a ser opcionais
alter table public.tasks alter column slack_channel_id drop not null;
alter table public.tasks alter column slack_ts drop not null;
alter table public.tasks alter column raw_text drop not null;
alter table public.tasks add column if not exists source text not null default 'slack'
  check (source in ('slack', 'manual'));

-- 2) Matriz Esforço x Impacto
--    ei1 = Ganhos rápidos (alto impacto, baixo esforço)
--    ei2 = Grandes projetos (alto impacto, alto esforço)
--    ei3 = Tarefas menores (baixo impacto, baixo esforço)
--    ei4 = Evitar agora (baixo impacto, alto esforço)
alter table public.tasks add column if not exists effort smallint check (effort between 1 and 5);
alter table public.tasks add column if not exists suggested_ei_quadrant text check (suggested_ei_quadrant in ('ei1','ei2','ei3','ei4'));
alter table public.tasks add column if not exists ei_quadrant text check (ei_quadrant in ('ei1','ei2','ei3','ei4'));
alter table public.tasks add column if not exists ei_moved_at timestamptz;

-- 3) Dono pode criar tarefas pelo site
drop policy if exists "owner can insert" on public.tasks;
create policy "owner can insert" on public.tasks for insert to authenticated with check (public.is_allowed());
