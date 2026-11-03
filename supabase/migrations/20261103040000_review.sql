-- Revisar tarefas: quando foi concluída + se já foi revisada
alter table public.tasks
  add column if not exists done_at timestamptz,
  add column if not exists reviewed boolean not null default false;

-- Tarefas já concluídas: melhor estimativa disponível
update public.tasks
   set done_at = greatest(created_at, coalesce(moved_at, created_at), coalesce(ei_moved_at, created_at))
 where done and done_at is null;

create or replace function public.set_done_at() returns trigger
language plpgsql as $$
begin
  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at := now();
  elsif not new.done then
    new.done_at := null;
    new.reviewed := false;
  end if;
  return new;
end $$;

drop trigger if exists tasks_set_done_at on public.tasks;
create trigger tasks_set_done_at before insert or update of done on public.tasks
  for each row execute function public.set_done_at();

create index if not exists tasks_owner_done_at on public.tasks (owner_id, done_at) where done;
