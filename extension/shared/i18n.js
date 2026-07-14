// Minimal, dependency-free i18n helper shared by the content script, popup,
// and settings page — plain classic script (no ES modules, matches every
// other file in shared/), same loading pattern as llm-adapters.js.
//
// Two ways to use it:
//   1. WT_I18N.t(key, vars) — call directly wherever JS builds a string
//      (toasts, dynamic overlay text, button labels set at runtime).
//   2. Static HTML markup (popup.html / settings.html): tag an element with
//      data-i18n="key" (sets textContent), data-i18n-html="key" (sets
//      innerHTML — for strings with embedded markup like <code>), or
//      data-i18n-placeholder="key" (sets the placeholder attribute), then
//      call WT_I18N.applyTo(document) once on load and again whenever the
//      locale changes.
//
// Any new string added here MUST have both an `en` and a `vi` entry — `en`
// is the fallback for any key missing from a non-English locale.
(function (global) {
  const STRINGS = {
    en: {
      // ── pre-translate whole chapter (overlay + toasts) ──────────────────
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

      // ── popup ────────────────────────────────────────────────────────────
      'popup.enabled_toggle_title':  'Enable / disable extension',
      'popup.settings_title':        'Settings',
      'popup.disabled_notice':       'Extension is turned off. Flip the switch to re-enable translation overlays.',
      'popup.no_chapter':            'Open a supported webtoon chapter to get started.',
      'popup.chapter_label':         'Chapter',
      'popup.progress_label':        'Progress',
      'popup.translate_all_btn':     'Pre-translate whole chapter',
      'popup.translation_list_btn':  'Translation list',
      'popup.clear_btn':             'Clear chapter translations',
      'popup.progress_value':        '{done}/{total} panels ({pct}%)',

      // ── settings: navbar / tabs ─────────────────────────────────────────
      'settings.nav.page':           'Settings',
      'settings.theme.to_dark':      'Dark',
      'settings.theme.to_light':     'Light',
      'settings.locale.label':       'Language',
      'settings.tabs.general':       'General',
      'settings.tabs.ocr':           'OCR Engine',
      'settings.tabs.translation':   'Translation & Appearance',

      // ── settings: General tab ───────────────────────────────────────────
      'settings.general.heading':              'General',
      'settings.general.subtitle':             'Core behavior while reading webtoons',
      'settings.general.autodetect_label':     'Auto-detect bubbles',
      'settings.general.autodetect_desc':      'Automatically detect, OCR and translate speech bubbles as you scroll. Turn off to only translate regions you select manually.',
      'settings.general.autodetect_warning':   '⚠ Bubble detector model not downloaded yet — auto-detect won’t find bubbles until you download it below.',
      'settings.general.detector_model_label': 'Bubble Detector Model',
      'settings.general.detector_name':        'Detector',
      'settings.general.download_model_btn':   'Download model',
      'settings.general.remove_model_btn':     'Remove downloaded model',
      'settings.general.detector_hint':        'Downloaded once and cached in the browser — not part of the extension package, so this works whether you loaded the extension unpacked or installed it from the Chrome Web Store. Fully offline after that.',
      'settings.general.shortcuts_heading':    'Keyboard shortcuts',
      'settings.general.shortcut_toggle_vis':  'Toggle translation visibility',
      'settings.general.shortcut_scan_mode':   'Toggle Quick OCR Translate scan mode',

      // ── settings: OCR Engine tab ────────────────────────────────────────
      'settings.ocr.heading':          'OCR Engine',
      'settings.ocr.subtitle':         'Choose how text is extracted from webtoon panels',
      'settings.ocr.badge_offline':    'Offline',
      'settings.ocr.badge_recommended':'Recommended',
      'settings.ocr.badge_selfhost':   'Self-hosted',
      'settings.ocr.tesseract_name':   'Tesseract.js',
      'settings.ocr.tesseract_detail': 'Runs locally in your browser. No data sent externally. Slower on first use while model loads.',
      'settings.ocr.paddlelocal_name': 'PaddleOCR (in-browser)',
      'settings.ocr.paddlelocal_detail':'PP-OCR models run locally via WebGPU/WASM. One-time ~15 MB download, cached in the browser — see the model status below.',
      'settings.ocr.paddlelocal_hw_warning': '⚠ This device may not have WebGPU and has few CPU cores — in-browser PaddleOCR could run slowly. Tesseract.js is faster on weak hardware; self-hosted PaddleOCR keeps the same accuracy without local inference cost.',
      'settings.ocr.paddleself_name':  'PaddleOCR (self-hosted)',
      'settings.ocr.paddleself_detail':'Best Korean accuracy. Runs on your own machine — see the setup guide below.',
      'settings.ocr.server_url_label': 'PaddleOCR Server URL',
      'settings.ocr.server_url_saved': '✓ Server URL saved successfully',
      'settings.ocr.server_url_hint':  'Leave empty to use the default. You need to run this server yourself — see the setup guide below.',
      'settings.ocr.setup_guide_toggle':'Setup guide — run the PaddleOCR server locally',
      'settings.ocr.setup_step1':      'Download the files below into an empty folder.',
      'settings.ocr.setup_step2':      'Install Python 3.9–3.12, open a terminal in that folder, then run:',
      'settings.ocr.setup_step3a':     'Start the server:',
      'settings.ocr.setup_step3b':     'First run downloads ~30–60 MB of Korean OCR models — this can take a minute.',
      'settings.ocr.setup_step4_html': 'Set the server URL above (default <code>http://127.0.0.1:8868</code> already matches — leave the field empty).',
      'settings.ocr.setup_cpu_hint':   'CPU-only works fine, no GPU required — but PaddlePaddle inference is memory-hungry at startup; 4 GB+ RAM recommended for smooth performance (a rough estimate, not a benchmarked figure).',
      'settings.ocr.setup_docker_hint':'Prefer Docker? Download the Dockerfile too, then:',
      'settings.ocr.setup_bind_hint':  'The server binds to 127.0.0.1 by default (not reachable from other devices) and has no built-in authentication — keep it that way unless you trust your local network.',
      'settings.ocr.models_label':     'PaddleOCR Models',
      'settings.ocr.detector_name':    'Detector',
      'settings.ocr.recognizer_name':  'Recognizer',
      'settings.ocr.download_models_btn':'Download models',
      'settings.ocr.remove_models_btn':'Remove downloaded models',
      'settings.ocr.models_hint':      'Downloaded once (~15 MB total) and cached in the browser — not part of the extension package, so this works whether you loaded the extension unpacked or installed it from the Chrome Web Store. Fully offline after that.',
      'settings.ocr.stats_heading':    'OCR Confidence Stats',
      'settings.ocr.stats_subtitle':   'Average self-reported confidence per engine, tracked locally on this device',
      'settings.ocr.stats_reset_btn':  'Reset stats',
      'settings.ocr.stats_hint':       'Confidence is each engine’s own self-reported certainty, not a verified accuracy score — use it to compare relative trends between engines, not as an absolute quality measurement. Stats never leave your device.',

      // ── settings: Translation & Appearance tab ──────────────────────────
      'settings.tr.heading':               'Translation & Appearance',
      'settings.tr.subtitle':              'Auto-translate OCR text and customize how translation bubbles look',
      'settings.tr.api_label':             'Translation API',
      'settings.tr.chrome_name':           'Chrome Built-in AI',
      'settings.tr.chrome_badge':          'Free · Offline · No key needed',
      'settings.tr.chrome_detail':         'Uses Chrome’s on-device Translator API. Fully private and works offline once the language model is downloaded. Desktop Chrome only — unsupported browsers/language pairs fall back to Google Translate automatically.',
      'settings.tr.google_name':           'Google Translate',
      'settings.tr.google_badge':          'Free · No key needed',
      'settings.tr.google_detail':         'Uses Google’s unofficial API. Fast and supports 130+ languages. No sign-up required.',
      'settings.tr.byok_name':              'Bring Your Own Key',
      'settings.tr.byok_badge':             'LLM · API key required',
      'settings.tr.byok_detail':            'Use your own LLM API key (OpenAI, Anthropic, etc). Translates automatically with story context for better accuracy.',
      'settings.tr.chrome_model_label':     'On-device Model (Korean → Target Language)',
      'settings.tr.chrome_error_hint':      'Re-checked automatically whenever you change the target language below.',
      'settings.tr.preset_label':           'Preset',
      'settings.tr.preset_add_btn':         '+ New preset',
      'settings.tr.preset_rename_btn':      'Rename',
      'settings.tr.preset_delete_btn':      'Delete',
      'settings.tr.preset_hint':            'Save separate key/provider/model/mode combos — e.g. "Fast & cheap" vs "High quality" — and switch between them instantly without retyping a key.',
      'settings.tr.api_key_label':          'LLM API Key',
      'settings.tr.api_key_placeholder':    'Paste your LLM API key…',
      'settings.tr.api_key_error':          'An API key is required to use Bring Your Own Key.',
      'settings.tr.provider_label':         'Provider',
      'settings.tr.model_label':            'Model',
      'settings.tr.model_hint':             'Which provider your key is for, and the exact model name to request.',
      'settings.tr.mode_label':             'Translation Mode',
      'settings.tr.mode_always_title':      'Always use LLM',
      'settings.tr.mode_always_desc':       'Every bubble is translated by your LLM — best quality, higher API cost.',
      'settings.tr.mode_smart_title':       'Smart (Hybrid)',
      'settings.tr.mode_smart_desc':        'Simple text uses Google Translate (free, fast); complex or low-confidence text uses your LLM.',
      'settings.tr.target_lang_label':      'Target Language',
      'settings.tr.display_mode_heading':   'Display Mode',
      'settings.tr.display_mode_subtitle':  'Choose how the translation is positioned relative to the original text',
      'settings.tr.overlay_name':           'Overlay on original',
      'settings.tr.overlay_detail':         'Translation is drawn directly on top of the original text. Hold a bubble to peek at the source underneath.',
      'settings.tr.sidebyside_name':        'Side-by-side',
      'settings.tr.sidebyside_detail':      'Translation is drawn beside the original region instead of on top of it, for direct comparison.',
      'settings.tr.appearance_divider':     'Appearance',
      'settings.tr.opacity_label':          'Bubble background opacity',
      'settings.tr.opacity_hint':           'Controls bubble background transparency. Text always stays fully visible. Set to 0 for no background.',
      'settings.tr.font_heading':           'Translation font',
      'settings.tr.font_default_name':      'Default',
      'settings.tr.font_custom_name':       'Custom…',
      'settings.tr.font_custom_placeholder_preview': 'Enter a Google Font name',
      'settings.tr.font_custom_input_placeholder':   'e.g. Noto Serif KR',
      'settings.tr.font_apply_btn':         'Apply',
      'settings.tr.font_hint_prefix':       'Applied to all translation bubbles.',
      'settings.tr.font_gfonts_link_text':  'Browse Google Fonts ↗',

      'settings.footer_hint': 'Settings save automatically',
    },
    vi: {
      // ── pre-translate whole chapter (overlay + toasts) ──────────────────
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

      // ── popup ────────────────────────────────────────────────────────────
      'popup.enabled_toggle_title':  'Bật/tắt extension',
      'popup.settings_title':        'Cài đặt',
      'popup.disabled_notice':       'Extension đang tắt. Bật công tắc để kích hoạt lại lớp phủ bản dịch.',
      'popup.no_chapter':            'Mở một chapter webtoon được hỗ trợ để bắt đầu.',
      'popup.chapter_label':         'Chương',
      'popup.progress_label':        'Tiến độ',
      'popup.translate_all_btn':     'Dịch trước toàn bộ chapter',
      'popup.translation_list_btn':  'Danh sách bản dịch',
      'popup.clear_btn':             'Xoá bản dịch chapter này',
      'popup.progress_value':        '{done}/{total} panel ({pct}%)',

      // ── settings: navbar / tabs ─────────────────────────────────────────
      'settings.nav.page':           'Cài đặt',
      'settings.theme.to_dark':      'Tối',
      'settings.theme.to_light':     'Sáng',
      'settings.locale.label':       'Ngôn ngữ',
      'settings.tabs.general':       'Chung',
      'settings.tabs.ocr':           'Bộ máy OCR',
      'settings.tabs.translation':   'Dịch & Giao diện',

      // ── settings: General tab ───────────────────────────────────────────
      'settings.general.heading':              'Chung',
      'settings.general.subtitle':             'Hành vi cốt lõi khi đọc webtoon',
      'settings.general.autodetect_label':     'Tự động phát hiện bubble',
      'settings.general.autodetect_desc':      'Tự động phát hiện, OCR và dịch bubble thoại khi bạn cuộn trang. Tắt đi nếu chỉ muốn dịch vùng bạn tự chọn.',
      'settings.general.autodetect_warning':   '⚠ Chưa tải model phát hiện bubble — tính năng tự động phát hiện sẽ không hoạt động cho đến khi bạn tải model bên dưới.',
      'settings.general.detector_model_label': 'Model phát hiện Bubble',
      'settings.general.detector_name':        'Bộ phát hiện',
      'settings.general.download_model_btn':   'Tải model',
      'settings.general.remove_model_btn':     'Xoá model đã tải',
      'settings.general.detector_hint':        'Chỉ tải một lần và lưu trong cache trình duyệt — không nằm trong gói extension, nên hoạt động dù bạn cài unpacked hay từ Chrome Web Store. Hoàn toàn offline sau đó.',
      'settings.general.shortcuts_heading':    'Phím tắt',
      'settings.general.shortcut_toggle_vis':  'Bật/tắt hiển thị bản dịch',
      'settings.general.shortcut_scan_mode':   'Bật/tắt chế độ quét dịch nhanh',

      // ── settings: OCR Engine tab ────────────────────────────────────────
      'settings.ocr.heading':          'Bộ máy OCR',
      'settings.ocr.subtitle':         'Chọn cách trích xuất text từ panel webtoon',
      'settings.ocr.badge_offline':    'Ngoại tuyến',
      'settings.ocr.badge_recommended':'Đề xuất',
      'settings.ocr.badge_selfhost':   'Tự triển khai',
      'settings.ocr.tesseract_name':   'Tesseract.js',
      'settings.ocr.tesseract_detail': 'Chạy cục bộ ngay trong trình duyệt. Không gửi dữ liệu ra ngoài. Chậm hơn ở lần dùng đầu khi model đang tải.',
      'settings.ocr.paddlelocal_name': 'PaddleOCR (trong trình duyệt)',
      'settings.ocr.paddlelocal_detail':'Model PP-OCR chạy cục bộ qua WebGPU/WASM. Tải một lần ~15 MB, lưu trong cache trình duyệt — xem trạng thái model bên dưới.',
      'settings.ocr.paddlelocal_hw_warning': '⚠ Thiết bị này có thể không có WebGPU và ít nhân CPU — PaddleOCR trong trình duyệt có thể chạy chậm. Tesseract.js nhanh hơn trên phần cứng yếu; PaddleOCR tự triển khai giữ độ chính xác tương đương mà không tốn tài nguyên máy.',
      'settings.ocr.paddleself_name':  'PaddleOCR (tự triển khai)',
      'settings.ocr.paddleself_detail':'Độ chính xác tiếng Hàn tốt nhất. Chạy trên máy riêng của bạn — xem hướng dẫn cài đặt bên dưới.',
      'settings.ocr.server_url_label': 'URL Server PaddleOCR',
      'settings.ocr.server_url_saved': '✓ Đã lưu URL server thành công',
      'settings.ocr.server_url_hint':  'Để trống để dùng mặc định. Bạn cần tự chạy server này — xem hướng dẫn cài đặt bên dưới.',
      'settings.ocr.setup_guide_toggle':'Hướng dẫn cài đặt — chạy PaddleOCR server cục bộ',
      'settings.ocr.setup_step1':      'Tải các file bên dưới vào một thư mục trống.',
      'settings.ocr.setup_step2':      'Cài Python 3.9–3.12, mở terminal trong thư mục đó, rồi chạy:',
      'settings.ocr.setup_step3a':     'Khởi động server:',
      'settings.ocr.setup_step3b':     'Lần chạy đầu sẽ tải ~30–60 MB model OCR tiếng Hàn — có thể mất một phút.',
      'settings.ocr.setup_step4_html': 'Đặt URL server ở trên (mặc định <code>http://127.0.0.1:8868</code> đã khớp sẵn — để trống là được).',
      'settings.ocr.setup_cpu_hint':   'Chạy CPU-only vẫn ổn, không cần GPU — nhưng PaddlePaddle inference tốn RAM lúc khởi động; khuyến nghị 4 GB+ RAM để chạy mượt (con số ước lượng, chưa benchmark chính xác).',
      'settings.ocr.setup_docker_hint':'Thích dùng Docker hơn? Tải luôn Dockerfile, rồi:',
      'settings.ocr.setup_bind_hint':  'Server mặc định bind vào 127.0.0.1 (không truy cập được từ thiết bị khác) và không có xác thực sẵn — giữ nguyên như vậy trừ khi bạn tin tưởng mạng nội bộ của mình.',
      'settings.ocr.models_label':     'Model PaddleOCR',
      'settings.ocr.detector_name':    'Bộ phát hiện',
      'settings.ocr.recognizer_name':  'Bộ nhận dạng',
      'settings.ocr.download_models_btn':'Tải model',
      'settings.ocr.remove_models_btn':'Xoá model đã tải',
      'settings.ocr.models_hint':      'Tải một lần (~15 MB) và lưu trong cache trình duyệt — không nằm trong gói extension, nên hoạt động dù bạn cài unpacked hay từ Chrome Web Store. Hoàn toàn offline sau đó.',
      'settings.ocr.stats_heading':    'Thống kê độ tin cậy OCR',
      'settings.ocr.stats_subtitle':   'Độ tin cậy trung bình tự báo cáo của mỗi engine, theo dõi cục bộ trên thiết bị này',
      'settings.ocr.stats_reset_btn':  'Đặt lại thống kê',
      'settings.ocr.stats_hint':       'Độ tin cậy là mức tự tin do chính engine báo cáo, không phải điểm chính xác đã kiểm chứng — dùng để so sánh xu hướng tương đối giữa các engine, không phải thước đo chất lượng tuyệt đối. Thống kê không rời khỏi thiết bị của bạn.',

      // ── settings: Translation & Appearance tab ──────────────────────────
      'settings.tr.heading':               'Dịch & Giao diện',
      'settings.tr.subtitle':              'Tự động dịch text OCR và tuỳ chỉnh giao diện bubble dịch',
      'settings.tr.api_label':             'API Dịch',
      'settings.tr.chrome_name':           'Chrome AI tích hợp sẵn',
      'settings.tr.chrome_badge':          'Miễn phí · Ngoại tuyến · Không cần key',
      'settings.tr.chrome_detail':         'Dùng Translator API tích hợp sẵn của Chrome. Riêng tư hoàn toàn và hoạt động ngoại tuyến sau khi tải model ngôn ngữ. Chỉ dùng được trên Chrome desktop — trình duyệt/cặp ngôn ngữ không hỗ trợ sẽ tự chuyển sang Google Translate.',
      'settings.tr.google_name':           'Google Translate',
      'settings.tr.google_badge':          'Miễn phí · Không cần key',
      'settings.tr.google_detail':         'Dùng API không chính thức của Google. Nhanh và hỗ trợ hơn 130 ngôn ngữ. Không cần đăng ký.',
      'settings.tr.byok_name':              'Dùng key riêng (BYOK)',
      'settings.tr.byok_badge':             'LLM · Cần API key',
      'settings.tr.byok_detail':            'Dùng API key LLM của riêng bạn (OpenAI, Anthropic, v.v). Tự động dịch có ngữ cảnh truyện để chính xác hơn.',
      'settings.tr.chrome_model_label':     'Model cục bộ (Hàn → Ngôn ngữ đích)',
      'settings.tr.chrome_error_hint':      'Tự động kiểm tra lại mỗi khi bạn đổi ngôn ngữ đích bên dưới.',
      'settings.tr.preset_label':           'Preset',
      'settings.tr.preset_add_btn':         '+ Preset mới',
      'settings.tr.preset_rename_btn':      'Đổi tên',
      'settings.tr.preset_delete_btn':      'Xoá',
      'settings.tr.preset_hint':            'Lưu riêng từng bộ key/provider/model/chế độ — ví dụ "Nhanh & rẻ" và "Chất lượng cao" — rồi chuyển đổi tức thì mà không cần nhập lại key.',
      'settings.tr.api_key_label':          'LLM API Key',
      'settings.tr.api_key_placeholder':    'Dán API key LLM của bạn…',
      'settings.tr.api_key_error':          'Cần có API key để dùng chế độ Dùng key riêng.',
      'settings.tr.provider_label':         'Provider',
      'settings.tr.model_label':            'Model',
      'settings.tr.model_hint':             'Provider mà key của bạn dùng, và tên model chính xác để gọi.',
      'settings.tr.mode_label':             'Chế độ dịch',
      'settings.tr.mode_always_title':      'Luôn dùng LLM',
      'settings.tr.mode_always_desc':       'Mọi bubble đều được LLM dịch — chất lượng tốt nhất, chi phí API cao hơn.',
      'settings.tr.mode_smart_title':       'Thông minh (Kết hợp)',
      'settings.tr.mode_smart_desc':        'Text đơn giản dùng Google Translate (miễn phí, nhanh); text phức tạp hoặc độ tin cậy thấp dùng LLM của bạn.',
      'settings.tr.target_lang_label':      'Ngôn ngữ đích',
      'settings.tr.display_mode_heading':   'Chế độ hiển thị',
      'settings.tr.display_mode_subtitle':  'Chọn cách bản dịch hiển thị so với text gốc',
      'settings.tr.overlay_name':           'Phủ lên bản gốc',
      'settings.tr.overlay_detail':         'Bản dịch được vẽ trực tiếp đè lên text gốc. Giữ bubble để xem bản gốc bên dưới.',
      'settings.tr.sidebyside_name':        'Song song',
      'settings.tr.sidebyside_detail':      'Bản dịch được vẽ bên cạnh vùng gốc thay vì đè lên, để so sánh trực tiếp.',
      'settings.tr.appearance_divider':     'Giao diện',
      'settings.tr.opacity_label':          'Độ mờ nền bubble',
      'settings.tr.opacity_hint':           'Điều chỉnh độ trong suốt của nền bubble. Text luôn hiển thị đầy đủ. Đặt 0 để không có nền.',
      'settings.tr.font_heading':           'Font chữ bản dịch',
      'settings.tr.font_default_name':      'Mặc định',
      'settings.tr.font_custom_name':       'Tuỳ chỉnh…',
      'settings.tr.font_custom_placeholder_preview': 'Nhập tên Google Font',
      'settings.tr.font_custom_input_placeholder':   'vd: Noto Serif KR',
      'settings.tr.font_apply_btn':         'Áp dụng',
      'settings.tr.font_hint_prefix':       'Áp dụng cho mọi bubble bản dịch.',
      'settings.tr.font_gfonts_link_text':  'Xem thêm Google Fonts ↗',

      'settings.footer_hint': 'Cài đặt tự động lưu',
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

  // Walks `root` for data-i18n*/data-i18n-html/data-i18n-placeholder
  // attributes and fills them in from the current locale. Extension-page-
  // only (popup.html/settings.html) — never called against a third-party
  // webtoon page's DOM from the content script.
  function applyTo(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
  }

  global.WT_I18N = { LOCALES, setLocale, getLocale, t, applyTo };
})(typeof self !== 'undefined' ? self : this);
