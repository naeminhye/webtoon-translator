# Backend migration guide

## Phase 1 → Phase 2: Adding Supabase

1. Create a Supabase project at https://supabase.com
2. Run `migrations/001_init.sql` in the SQL editor
3. Copy `.env.example` → `.env` and fill in `SUPABASE_URL` + `SUPABASE_ANON_KEY`
4. In `background/worker.js`:
   - Replace `handleSave` with a `POST /rest/v1/translations` Supabase REST call
   - Replace `handleLoad` with a `GET /rest/v1/translations?site=...&title_id=...` call
   - Add `Authorization: Bearer <user_jwt>` header on mutating requests
5. Add login UI to popup (Supabase Auth email link or OAuth)

## Migrating away from Supabase to custom backend

The schema in `001_init.sql` is plain Postgres — no Supabase-specific extensions.

Replace these Supabase-isms:

| Supabase feature | Replacement |
|---|---|
| `auth.users` table | Your users table; update foreign keys accordingly |
| `auth.uid()` in RLS | Remove RLS; enforce in your API middleware instead |
| Supabase REST API (`/rest/v1/`) | Your Express/FastAPI/etc. endpoints |
| Supabase Storage bucket | AWS S3, Cloudflare R2, or GCS for export ZIPs |
| `supabase-js` client | `fetch()` against your API |

The content script's `sendToBackground()` → `background/worker.js` boundary is the
only place that touches network. Swap the API calls there; the rest of the
extension doesn't change.

## Scaling notes

- Add a `cdn_url` column to `chapters` if you want to cache chapter image lists
- Add full-text search on `original_text`/`translated_text` via Postgres `tsvector`
- `upvotes` is a simple counter — add a `translation_votes` table if you need per-user dedup
- Rate-limit inserts per `contributor_id` at the API layer (not RLS)
