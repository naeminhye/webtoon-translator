// Minimal, dependency-free i18n helper shared by the content script, popup,
// and settings page — plain classic script (no ES modules, matches every
// other file in shared/), same loading pattern as llm-adapters.js.
//
// Scope: currently only the "pre-translate whole chapter" feature's UI
// strings are wired through this (see the batch.* keys below) — the rest
// of the extension is still English-only hardcoded text, ported over
// incrementally rather than all at once. Any new string added here MUST
// have both an `en` and a `vi` entry — `en` is the fallback for any key
// missing from a non-English locale.
(function (global) {
  const STRINGS = {
    en: {
      'batch.scanning':              'Scanning chapter…',
      'batch.rescan':                'Re-scanning the whole page (catching slow-loading panels)…',
      'batch.ocr_translating':       'Running OCR + translating in groups… {done}/{total} lines done',
      'batch.stopping':              'Stopping — waiting for in-progress work, then saving…',
      'batch.stopping_progress':     'Stopping… {done}/{total} lines done, saving what’s left',
      'batch.translating_remaining': 'Translating the remaining {count} lines…',
      'batch.done':                  '✓ Done!',
      'batch.done_toast':            '✓ Finished translating this chapter.',
      'batch.cancelled_overlay':     '✓ Stopped — saved {count} translated lines.',
      'batch.cancelled_toast':       '✓ Cancelled — saved {count} translated bubbles.',
      'batch.already_running':       'Already translating this chapter…',
      'batch.no_panels':             'No panels found on this page yet.',
      'batch.dont_close':            'Don’t close the tab or navigate away until this finishes — translation is running across the whole chapter.',
      'batch.cancel_btn':            'Cancel',
      'batch.cancelling_btn':        'Stopping…',
      'popup.translate_all_btn':     'Pre-translate whole chapter',
    },
    vi: {
      'batch.scanning':              'Đang quét chapter…',
      'batch.rescan':                'Đang quét lại toàn trang (bắt các panel lỡ tải chậm)…',
      'batch.ocr_translating':       'Đang chạy OCR + dịch theo từng nhóm… {done}/{total} đoạn text đã xong',
      'batch.stopping':              'Đang dừng — chờ nốt phần đang xử lý rồi lưu lại…',
      'batch.stopping_progress':     'Đang dừng… {done}/{total} đoạn text đã xong, đang lưu nốt',
      'batch.translating_remaining': 'Đang dịch nốt {count} đoạn text còn lại…',
      'batch.done':                  '✓ Hoàn tất!',
      'batch.done_toast':            '✓ Đã dịch xong chapter này.',
      'batch.cancelled_overlay':     '✓ Đã dừng — đã lưu {count} đoạn đã dịch xong.',
      'batch.cancelled_toast':       '✓ Đã hủy — đã lưu {count} bubble đã dịch xong.',
      'batch.already_running':       'Đang dịch chapter này rồi…',
      'batch.no_panels':             'Chưa tìm thấy panel nào trên trang này.',
      'batch.dont_close':            'Đừng đóng tab hoặc chuyển trang cho đến khi hoàn tất — bản dịch đang chạy trên toàn bộ chapter.',
      'batch.cancel_btn':            'Hủy',
      'batch.cancelling_btn':        'Đang dừng…',
      'popup.translate_all_btn':     'Dịch trước toàn bộ chapter',
    },
  };

  const LOCALES = Object.keys(STRINGS);
  let currentLocale = 'en';

  function setLocale(locale) {
    currentLocale = STRINGS[locale] ? locale : 'en';
  }

  function getLocale() {
    return currentLocale;
  }

  // vars: optional {key: value} map substituted into "{key}" placeholders.
  function t(key, vars) {
    const dict = STRINGS[currentLocale] || STRINGS.en;
    let str = dict[key] ?? STRINGS.en[key] ?? key;
    if (vars) {
      for (const k of Object.keys(vars)) str = str.split(`{${k}}`).join(vars[k]);
    }
    return str;
  }

  global.WT_I18N = { LOCALES, setLocale, getLocale, t };
})(typeof self !== 'undefined' ? self : this);
