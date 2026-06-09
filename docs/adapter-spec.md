# Adding a new site adapter

## Checklist

1. Create `extension/content/adapters/mysite.js` extending `SiteAdapter`
2. Implement all 4 required methods (see below)
3. Add to `ADAPTERS` array in `extension/content/index.js`
4. Add host permission in `manifest.json` → `host_permissions`
5. Add URL pattern in `manifest.json` → `content_scripts[].matches`

## Required methods

### `detect(): boolean`
Pure URL check only — called on every page load, must be instant.
```js
detect() {
  return location.hostname === 'mysite.com' && location.pathname.startsWith('/read/');
}
```

### `getChapterMeta(): ChapterMeta`
Returns `{ site, titleId, chapterId }`. Parse from URL first; fall back to
`__NEXT_DATA__` or other page state if needed.

`site` must be a short lowercase string that is safe to use in filenames
and storage keys (no spaces, slashes, or colons).

### `getImages(): HTMLImageElement[]`
Returns panel images in reading order. Filter out navigation icons and
thumbnails — a safe heuristic is `naturalWidth > 100` once loaded,
or `width > 100` from CSS if image is still loading.

If images are inside an iframe, you need `"all_frames": true` in `manifest.json`.

### `watchNewImages(callback): () => void`
Calls `callback(allImages)` whenever new images appear (infinite scroll,
page navigation within SPA). Returns a cleanup function.

Use `MutationObserver` on the scroll container, not on `document.body`,
to avoid false triggers from unrelated DOM changes.

## Tips

- Check `__NEXT_DATA__` or `window.__APP_STATE__` for titleId/chapterId
  if they're not in the URL
- Some sites load images behind authentication cookies — the `fetch()` in
  `hasher.js` uses `credentials: 'include'` to handle this
- If the site renders images as CSS `background-image`, you need a different
  approach: collect the elements and extract the URL from `computedStyle`
- Kakao splits some panels into 2–3 horizontal image slices — decide whether
  to treat each slice as a separate annotation target or group them
