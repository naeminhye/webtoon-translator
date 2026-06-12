-- backend/supabase/migrations/003_auto_create_profile.sql
--
-- Supabase Auth creates users in auth.users but NOT in public.profiles.
-- This trigger auto-creates a profile row on every new auth user so the
-- translations.contributor_id FK never fails.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    'translator'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfill existing auth users who don't have a profile yet
insert into public.profiles (id, username, role)
select
  id,
  coalesce(raw_user_meta_data->>'username', split_part(email, '@', 1)),
  'translator'
from auth.users
on conflict (id) do nothing;
