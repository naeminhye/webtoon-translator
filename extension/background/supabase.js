/**
 * background/supabase.js
 * Supabase REST + Auth client using plain fetch — no npm dependency.
 *
 * Config stored in chrome.storage.local under 'wt:supabase':
 *   { url, anonKey, session }
 *
 * Developers can hardcode DEV_URL / DEV_ANON_KEY below to ship a
 * pre-configured build; user-entered values take precedence.
 */

const STORAGE_KEY   = 'wt:supabase';
const DEV_URL       = '';   // e.g. 'https://xxxx.supabase.co'
const DEV_ANON_KEY  = '';   // your project's anon/public key

// ── Config ────────────────────────────────────────────────────────────────────

export async function getConfig() {
  const data = await _getLocal(STORAGE_KEY);
  return {
    url:      data?.url      || DEV_URL,
    anonKey:  data?.anonKey  || DEV_ANON_KEY,
    session:  data?.session  || null,
  };
}

export async function saveConfig({ url, anonKey }) {
  const existing = await _getLocal(STORAGE_KEY) || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...existing, url, anonKey } });
}

export async function isConfigured() {
  const { url, anonKey } = await getConfig();
  return Boolean(url && anonKey);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function signIn(email, password) {
  const { url, anonKey } = await getConfig();
  if (!url || !anonKey) throw new Error('Supabase not configured');

  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error('Project URL not found — check Project URL in Supabase → Settings → API');
    if (res.status === 400) throw new Error(err.error_description || err.msg || 'Invalid email or password');
    if (res.status === 401) throw new Error('Invalid API key (anon key)');
    throw new Error(err.error_description || err.msg || `Sign-in failed (${res.status})`);
  }
  const session = await res.json();
  await _saveSession(session);
  return session;
}

export async function signUp(email, password) {
  const { url, anonKey } = await getConfig();
  if (!url || !anonKey) throw new Error('Supabase not configured');

  const res = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.msg || `Sign-up failed (${res.status})`);
  }
  const session = await res.json();
  // Supabase may return a session immediately (if email confirm is off)
  if (session.access_token) await _saveSession(session);
  return session;
}

export async function signOut() {
  const { url, anonKey, session } = await getConfig();
  if (url && anonKey && session?.access_token) {
    await fetch(`${url}/auth/v1/logout`, {
      method: 'POST',
      headers: { 'apikey': anonKey, 'Authorization': `Bearer ${session.access_token}` },
    }).catch(() => {});
  }
  await _saveSession(null);
}

/** Returns current session, refreshing if near expiry. Returns null if not signed in. */
export async function getSession() {
  const { session } = await getConfig();
  if (!session?.access_token) return null;
  // Refresh if within 60 s of expiry
  if (session.expires_at && Date.now() / 1000 > session.expires_at - 60) {
    return _refreshSession(session.refresh_token);
  }
  return session;
}

async function _refreshSession(refreshToken) {
  const { url, anonKey } = await getConfig();
  if (!url || !anonKey || !refreshToken) { await _saveSession(null); return null; }
  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) { await _saveSession(null); return null; }
    const session = await res.json();
    await _saveSession(session);
    return session;
  } catch { await _saveSession(null); return null; }
}

async function _saveSession(session) {
  const existing = await _getLocal(STORAGE_KEY) || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...existing, session } });
}

// ── Translations CRUD ─────────────────────────────────────────────────────────

/**
 * Load all annotations for a chapter from Supabase.
 * Uses the anon key — no auth needed (public read policy).
 * Returns null if Supabase is not configured or the request fails.
 */
export async function loadChapter({ site, titleId, chapterId }) {
  const { url, anonKey } = await getConfig();
  if (!url || !anonKey) return null;

  const params = new URLSearchParams({
    site:       `eq.${site}`,
    title_id:   `eq.${titleId}`,
    chapter_id: `eq.${chapterId}`,
    select:     '*',
    order:      'image_index.asc,bbox_y.asc,bbox_x.asc',
  });

  try {
    const res = await _fetchWithTimeout(`${url}/rest/v1/translations?${params}`, {
      headers: { 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.map(_rowToAnnotation) : null;
  } catch { return null; }
}

/**
 * Upsert annotations to Supabase. Requires a signed-in session.
 * Uses the unique constraint (site, title_id, chapter_id, image_hash, bbox_x, bbox_y)
 * so repeated saves are idempotent.
 */
export async function saveAnnotations(annotations, { site, titleId, chapterId }) {
  const session = await getSession();
  const { url, anonKey } = await getConfig();
  if (!url || !anonKey || !session?.access_token) return false;

  const rows = annotations.map(ann =>
    _annotationToRow(ann, site, titleId, chapterId, session.user.id)
  );

  try {
    // on_conflict tells PostgREST exactly which columns define uniqueness for the upsert
    const res = await _fetchWithTimeout(
      `${url}/rest/v1/translations?on_conflict=site,title_id,chapter_id,image_hash,bbox_x,bbox_y`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
          'Authorization': `Bearer ${session.access_token}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.message || err.hint || err.code || `HTTP ${res.status}`;
      console.error('[WebtoonTranslate] Supabase save failed:', msg, err);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    console.error('[WebtoonTranslate] Supabase save error:', e);
    return { ok: false, error: e.message };
  }
}

/**
 * Delete a single annotation from Supabase by its ann_key.
 * ann_key format: imageHash::bboxX::bboxY
 */
export async function deleteAnnotation({ site, titleId, chapterId, annKey }) {
  const session = await getSession();
  const { url, anonKey: apiKey } = await getConfig();
  if (!url || !apiKey || !session?.access_token) return false;

  const [imageHash, bboxX, bboxY] = annKey.split('::');
  const params = new URLSearchParams({
    site:       `eq.${site}`,
    title_id:   `eq.${titleId}`,
    chapter_id: `eq.${chapterId}`,
    image_hash: `eq.${imageHash}`,
    bbox_x:     `eq.${bboxX}`,
    bbox_y:     `eq.${bboxY}`,
  });

  try {
    const res = await _fetchWithTimeout(`${url}/rest/v1/translations?${params}`, {
      method: 'DELETE',
      headers: {
        'apikey': apiKey,
        'Authorization': `Bearer ${session.access_token}`,
      },
    });
    return res.ok;
  } catch { return false; }
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function _rowToAnnotation(row) {
  return {
    imageHash:      row.image_hash,
    imageIndex:     row.image_index,
    bbox: {
      x: parseFloat(row.bbox_x),
      y: parseFloat(row.bbox_y),
      w: parseFloat(row.bbox_w),
      h: parseFloat(row.bbox_h),
    },
    originalText:   row.original_text  || '',
    translatedText: row.translated_text,
    language:       row.language       || 'vi',
    style:          row.style          || {},
    createdAt:      row.created_at,
  };
}

function _annotationToRow(ann, site, titleId, chapterId, contributorId) {
  return {
    site,
    title_id:        titleId,
    chapter_id:      chapterId,
    image_hash:      ann.imageHash,
    image_index:     ann.imageIndex ?? 0,
    bbox_x:          ann.bbox.x,
    bbox_y:          ann.bbox.y,
    bbox_w:          ann.bbox.w,
    bbox_h:          ann.bbox.h,
    original_text:   ann.originalText  || null,
    translated_text: ann.translatedText,
    language:        ann.language      || 'vi',
    style:           ann.style         || null,
    contributor_id:  contributorId,
  };
}

// ── Internal utils ────────────────────────────────────────────────────────────

function _fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

function _getLocal(key) {
  return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key])));
}
