/**
 * bench/lib/jsonl.js — accumulates benchmark records and produces the
 * JSONL output file: one JSON object per line, per benchmark-plan.md's
 * "Output format" — {suite, config, env, metrics, timestamp, corpus_hash}.
 */

export class JsonlWriter {
  constructor() {
    this.records = [];
  }

  add(record) {
    this.records.push({ timestamp: new Date().toISOString(), ...record });
  }

  toText() {
    return this.records.map(r => JSON.stringify(r)).join('\n') + (this.records.length ? '\n' : '');
  }

  download(filename) {
    const blob = new Blob([this.toText()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}
