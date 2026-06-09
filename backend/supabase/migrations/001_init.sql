-- backend/supabase/migrations/001_init.sql
-- Phase 2 schema. Not used in Phase 1 (local storage only).
--
-- Migration note (if moving away from Supabase):
--   - This is plain Postgres — runs unmodified on any Postgres 14+ instance
--   - RLS policies are Supabase-specific; replace with your auth middleware
--   - Storage bucket → replace with S3/R2/GCS for export ZIPs
--   - auth.uid() → replace with your JWT user ID function

-- ── Profiles ─────────────────────────────────────────────────────────────

create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  username    text unique not null,
  role        text not null default 'reader', -- 'reader' | 'translator' | 'admin'
  trusted     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── Chapters (optional cache, makes queries faster) ───────────────────────

create table chapters (
  id              bigserial primary key,
  site            text not null,  -- 'naver' | 'ridi' | 'kakao'
  title_id        text not null,
  chapter_id      text not null,
  chapter_url     text,
  image_count     int,
  created_at      timestamptz not null default now(),
  unique (site, title_id, chapter_id)
);

-- ── Translations ──────────────────────────────────────────────────────────

create table translations (
  id              bigserial primary key,
  site            text not null,
  title_id        text not null,
  chapter_id      text not null,
  image_hash      text not null,   -- 'sha256:...' or 'url:...' fallback
  image_index     int not null,    -- 0-based fallback ordering
  -- BBox stored as % (0.0–100.0) — stable across viewport/zoom changes
  bbox_x          numeric(6,2) not null,
  bbox_y          numeric(6,2) not null,
  bbox_w          numeric(6,2) not null,
  bbox_h          numeric(6,2) not null,
  original_text   text,
  translated_text text not null,
  language        text not null default 'vi',  -- BCP-47
  contributor_id  uuid references profiles(id) on delete set null,
  upvotes         int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on translations (site, title_id, chapter_id);
create index on translations (image_hash);

-- ── RLS Policies ──────────────────────────────────────────────────────────

alter table profiles     enable row level security;
alter table chapters     enable row level security;
alter table translations enable row level security;

-- Anyone can read translations (public webtoon data, no secrets)
create policy "public read translations"
  on translations for select using (true);

create policy "public read chapters"
  on chapters for select using (true);

-- Only translators and admins can insert translations
create policy "translators can insert"
  on translations for insert
  with check (
    exists (
      select 1 from profiles
      where id = auth.uid() and role in ('translator', 'admin')
    )
  );

-- Contributors can update their own; admins can update any
create policy "contributors can update own"
  on translations for update
  using (contributor_id = auth.uid() or
    exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- Users can read and update their own profile
create policy "users read own profile"
  on profiles for select using (id = auth.uid());

create policy "users update own profile"
  on profiles for update using (id = auth.uid());
