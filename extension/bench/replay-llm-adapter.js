/**
 * bench/replay-llm-adapter.js — Suite C replay mode.
 *
 * Loaded as a classic script AFTER shared/llm-adapters.js but BEFORE
 * content/bundle.js. bundle.js's autoTranslate() calls the bare identifier
 * `getLlmAdapter(provId)` fresh at call time (not captured at load time),
 * so overriding window.getLlmAdapter here — regardless of load order
 * relative to bundle.js, as long as it's set before bootForPage() actually
 * runs a job — makes every BYOK translation call resolve to a fixture
 * after a configurable synthetic delay instead of hitting a real API. This
 * isolates the pipeline's own detect/OCR/render/scheduling latency from
 * LLM-provider network variance, per benchmark-plan.md's Suite C
 * methodology ("replay mode... is the mode for regression tracking").
 *
 * Config is read fresh on every call from window.__WT_BENCH_REPLAY__, set
 * by suite-c.js before each scenario run.
 */
(function () {
  const DEFAULT_DELAY_MS = 400;
  const DEFAULT_TEXT = '[replay] fixture translation';

  function config() {
    return window.__WT_BENCH_REPLAY__ || {};
  }

  class ReplayLlmAdapter {
    async callApi() {
      const { delayMs = DEFAULT_DELAY_MS, fixtureText = DEFAULT_TEXT } = config();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return fixtureText;
    }
    async callVisionApi() {
      return this.callApi();
    }
  }

  const replayAdapter = new ReplayLlmAdapter();
  // Ignores providerId on purpose — replay mode always returns the fixture
  // adapter no matter which BYOK provider storage says is selected.
  window.getLlmAdapter = () => replayAdapter;
})();
