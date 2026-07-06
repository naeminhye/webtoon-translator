/**
 * shared/llm-adapters.js
 * Single source of truth for BYOK LLM providers — loaded as a plain classic
 * script (no bundler/ES modules in this project) both by the Settings popup
 * (for the Provider dropdown) and the content script (for the "Test LLM"
 * preview button's actual API call), so neither can drift out of sync with
 * what's actually implemented.
 *
 * To add a new provider: add one adapter instance to LLM_ADAPTERS below. It
 * appears in the Settings dropdown and the Test LLM flow automatically — no
 * other UI file needs to change. (It DOES need to be registered here; there's
 * no reflection-based auto-discovery of adapter classes.)
 */
(function (global) {
  'use strict';

  class LlmAdapter {
    constructor({ id, label, modelPlaceholder }) {
      this.id               = id;               // stored value, e.g. 'openai'
      this.label             = label;             // dropdown display text, e.g. 'OpenAI'
      this.modelPlaceholder = modelPlaceholder;  // Model field placeholder hint only, never a default
    }
    /* eslint-disable no-unused-vars */
    async callApi(apiKey, model, prompt) {
      throw new Error(`${this.constructor.name} must implement callApi()`);
    }
    async callVisionApi(apiKey, model, base64Data, mimeType, prompt) {
      throw new Error(`${this.constructor.name} does not support vision input`);
    }
    /* eslint-enable no-unused-vars */
  }

  class OpenAIAdapter extends LlmAdapter {
    constructor() {
      super({ id: 'openai', label: 'OpenAI', modelPlaceholder: 'gpt-4o-mini' });
    }
    async callApi(apiKey, model, prompt) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${res.status}`);
      return data.choices?.[0]?.message?.content ?? '';
    }
    async callVisionApi(apiKey, model, base64Data, mimeType, prompt) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
          { type: 'text', text: prompt },
        ] }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${res.status}`);
      return data.choices?.[0]?.message?.content ?? '';
    }
  }

  class AnthropicAdapter extends LlmAdapter {
    constructor() {
      super({ id: 'anthropic', label: 'Anthropic', modelPlaceholder: 'claude-haiku-4-5-20251001' });
    }
    async callApi(apiKey, model, prompt) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${res.status}`);
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
    }
    async callVisionApi(apiKey, model, base64Data, mimeType, prompt) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
          { type: 'text', text: prompt },
        ] }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${res.status}`);
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
    }
  }

  class GeminiAdapter extends LlmAdapter {
    constructor() {
      // gemini-1.5-flash was retired from the v1beta generateContent endpoint —
      // gemini-2.5-flash is the current fast/cheap default. This is only a
      // placeholder hint (see LlmAdapter doc comment); the Model field is free
      // text, so an already-saved older model name isn't touched by this.
      super({ id: 'gemini', label: 'Gemini', modelPlaceholder: 'gemini-2.5-flash' });
    }
    _extractText(data) {
      // Filter out thinking/reasoning parts (thought:true) — present in Gemini 2.5+ thinking models
      const parts = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought);
      return parts.map(p => p.text || '').join('');
    }
    async callApi(apiKey, model, prompt) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
      return this._extractText(data);
    }
    async callVisionApi(apiKey, model, base64Data, mimeType, prompt) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: prompt },
        ] }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
      return this._extractText(data);
    }
  }

  const LLM_ADAPTERS = [new OpenAIAdapter(), new AnthropicAdapter(), new GeminiAdapter()];

  global.WT_LLM_ADAPTERS = LLM_ADAPTERS;
  global.getLlmAdapter = (id) => LLM_ADAPTERS.find(a => a.id === id) || null;
})(typeof window !== 'undefined' ? window : self);
