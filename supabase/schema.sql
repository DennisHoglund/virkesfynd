-- Virkesfynd – databas och fotolagring i Supabase
-- Kör hela filen i Supabase: SQL Editor → New query → klistra in → Run.

-- 1. Tabell för fynd
create table if not exists public.fynd (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) default auth.uid(),
  skapad_av_namn  text,
  lat             double precision not null,
  lng             double precision not null,
  noggrannhet     real,
  typ             text not null default 'vindfalle'
                  check (typ in ('vindfalle','timmer','ris','annat')),
  kommentar       text,
  fotos           text[] not null default '{}',
  status          text not null default 'kvar'
                  check (status in ('kvar','hamtad')),
  hamtad_at       timestamptz,
  hamtad_av_namn  text
);

alter table public.fynd enable row level security;

-- Bara inloggade användare (registrering avstängd i Supabase) får läsa och skriva
drop policy if exists "fynd_select" on public.fynd;
drop policy if exists "fynd_insert" on public.fynd;
drop policy if exists "fynd_update" on public.fynd;
drop policy if exists "fynd_delete" on public.fynd;
create policy "fynd_select" on public.fynd for select to authenticated using (true);
create policy "fynd_insert" on public.fynd for insert to authenticated with check (true);
create policy "fynd_update" on public.fynd for update to authenticated using (true) with check (true);
create policy "fynd_delete" on public.fynd for delete to authenticated using (true);

-- Live-uppdateringar mellan enheter
do $$ begin
  alter publication supabase_realtime add table public.fynd;
exception when duplicate_object then null; end $$;

-- 2. Privat bucket för foton
insert into storage.buckets (id, name, public)
values ('foton', 'foton', false)
on conflict (id) do nothing;

drop policy if exists "foton_select" on storage.objects;
drop policy if exists "foton_insert" on storage.objects;
drop policy if exists "foton_update" on storage.objects;
drop policy if exists "foton_delete" on storage.objects;
create policy "foton_select" on storage.objects for select to authenticated using (bucket_id = 'foton');
create policy "foton_insert" on storage.objects for insert to authenticated with check (bucket_id = 'foton');
create policy "foton_update" on storage.objects for update to authenticated using (bucket_id = 'foton') with check (bucket_id = 'foton');
create policy "foton_delete" on storage.objects for delete to authenticated using (bucket_id = 'foton');
