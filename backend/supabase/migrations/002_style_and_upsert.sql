-- backend/supabase/migrations/002_style_and_upsert.sql

alter table translations add column if not exists style jsonb;

-- Unique constraint enables PostgREST upsert (resolution=merge-duplicates)
alter table translations
  add constraint translations_unique_ann
  unique (site, title_id, chapter_id, image_hash, bbox_x, bbox_y);

-- Auto-update updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger translations_updated_at
  before update on translations
  for each row execute function set_updated_at();

-- Simplify write policies: any signed-in user can write/edit/delete
-- (small trusted team — client enforces translate mode)
drop policy if exists "translators can insert" on translations;
drop policy if exists "contributors can update own" on translations;
drop policy if exists "contributors can delete own" on translations;

create policy "authenticated users can insert"
  on translations for insert
  with check (auth.uid() is not null);

create policy "authenticated users can update"
  on translations for update
  using (auth.uid() is not null);

create policy "authenticated users can delete"
  on translations for delete
  using (auth.uid() is not null);
