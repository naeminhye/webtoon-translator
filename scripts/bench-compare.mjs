#!/usr/bin/env node
/**
 * scripts/bench-compare.mjs — diffs two benchmark JSONL files (see
 * extension/bench/, benchmark-plan.md) and flags regressions:
 *   - p95 latency: +10% (relative)
 *   - CER: +2pp (absolute, e.g. 0.10 -> 0.12)
 *   - F1: -2pp (absolute) — NOT YET PRODUCED by any suite in this harness
 *     (Suite A is latency-only per an earlier decision; detection
 *     precision/recall/F1 against GT boxes isn't implemented yet). The
 *     scanner below looks for it anyway so this script needs no changes
 *     once that lands — it just won't find anything today.
 *
 * Usage:
 *   node scripts/bench-compare.mjs <baseline.jsonl> <candidate.jsonl> \
 *     [--latency-pct=10] [--cer-pp=2] [--f1-pp=2]
 *
 * Exits 1 if any regression is flagged (so it can gate CI), 0 otherwise.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../extension/bench/lib/hash.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(arg);
    if (m) flags[m[1]] = m[2];
    else positional.push(arg);
  }
  return { positional, flags };
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`${filePath}:${i + 1}: invalid JSON (${err.message})`);
    }
  });
}

/** Groups records by (suite, canonical config) — the same benchmark config run at two different times. */
function groupByKey(records) {
  const map = new Map();
  for (const record of records) {
    const key = `${record.suite}::${canonicalJson(record.config ?? null)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
  }
  return map;
}

/** Recursively finds every {..., p95: <number>} object in `value`, returning [{path, p95}]. */
function findLatencyStats(value, pathPrefix = []) {
  const out = [];
  if (!value || typeof value !== 'object') return out;
  if (typeof value.p95 === 'number' && typeof value.n === 'number') {
    out.push({ path: pathPrefix.join('.'), p95: value.p95, n: value.n });
    return out; // a stats-summary object (see lib/stats.js) is a leaf, don't recurse into it
  }
  for (const [k, v] of Object.entries(value)) {
    out.push(...findLatencyStats(v, [...pathPrefix, k]));
  }
  return out;
}

/** Recursively finds every numeric field named cerAggregate/meanCer/f1 (case-insensitive) in `value`. */
function findRateMetric(value, namePattern, pathPrefix = []) {
  const out = [];
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const p = [...pathPrefix, k];
    if (namePattern.test(k) && typeof v === 'number') {
      out.push({ path: p.join('.'), value: v });
    } else if (v && typeof v === 'object') {
      out.push(...findRateMetric(v, namePattern, p));
    }
  }
  return out;
}

function toMap(list, keyFn) {
  const m = new Map();
  for (const item of list) m.set(keyFn(item), item);
  return m;
}

function compareRecordPair(key, baselineRecord, candidateRecord, thresholds) {
  const findings = [];

  if (baselineRecord.corpus_hash && candidateRecord.corpus_hash && baselineRecord.corpus_hash !== candidateRecord.corpus_hash) {
    findings.push({ severity: 'warn', message: `corpus_hash differs (${baselineRecord.corpus_hash.slice(0, 12)}… vs ${candidateRecord.corpus_hash.slice(0, 12)}…) — comparison may not be apples-to-apples (see benchmark-plan.md's stale-corpus note)` });
  }
  if (baselineRecord.calibration?.dirty || candidateRecord.calibration?.dirty) {
    findings.push({ severity: 'warn', message: 'one or both runs had a dirty thermal calibration session — timing deltas may reflect throttling, not the code change' });
  }

  const baseLatency = toMap(findLatencyStats(baselineRecord.metrics), (s) => s.path);
  const candLatency = findLatencyStats(candidateRecord.metrics);
  for (const cand of candLatency) {
    const base = baseLatency.get(cand.path);
    if (!base || base.p95 == null || cand.p95 == null || base.p95 === 0) continue;
    const pctChange = ((cand.p95 - base.p95) / base.p95) * 100;
    if (pctChange > thresholds.latencyPct) {
      findings.push({
        severity: 'fail',
        message: `p95 latency regression at metrics.${cand.path}: ${base.p95.toFixed(1)}ms -> ${cand.p95.toFixed(1)}ms (+${pctChange.toFixed(1)}%, threshold +${thresholds.latencyPct}%)`,
      });
    }
  }

  const baseCer = toMap(findRateMetric(baselineRecord.metrics, /^(cerAggregate|meanCer)$/i), (s) => s.path);
  const candCer = findRateMetric(candidateRecord.metrics, /^(cerAggregate|meanCer)$/i);
  for (const cand of candCer) {
    const base = baseCer.get(cand.path);
    if (!base || base.value == null || cand.value == null) continue;
    const ppChange = (cand.value - base.value) * 100;
    if (ppChange > thresholds.cerPp) {
      findings.push({
        severity: 'fail',
        message: `CER regression at metrics.${cand.path}: ${(base.value * 100).toFixed(2)}% -> ${(cand.value * 100).toFixed(2)}% (+${ppChange.toFixed(2)}pp, threshold +${thresholds.cerPp}pp)`,
      });
    }
  }

  const baseF1 = toMap(findRateMetric(baselineRecord.metrics, /^f1$/i), (s) => s.path);
  const candF1 = findRateMetric(candidateRecord.metrics, /^f1$/i);
  for (const cand of candF1) {
    const base = baseF1.get(cand.path);
    if (!base || base.value == null || cand.value == null) continue;
    const ppChange = (base.value - cand.value) * 100;
    if (ppChange > thresholds.f1Pp) {
      findings.push({
        severity: 'fail',
        message: `F1 regression at metrics.${cand.path}: ${(base.value * 100).toFixed(2)}% -> ${(cand.value * 100).toFixed(2)}% (-${ppChange.toFixed(2)}pp, threshold -${thresholds.f1Pp}pp)`,
      });
    }
  }

  return findings;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [baselinePath, candidatePath] = positional;
  if (!baselinePath || !candidatePath) {
    console.error('Usage: node scripts/bench-compare.mjs <baseline.jsonl> <candidate.jsonl> [--latency-pct=10] [--cer-pp=2] [--f1-pp=2]');
    process.exit(2);
  }

  const thresholds = {
    latencyPct: Number(flags['latency-pct'] ?? 10),
    cerPp: Number(flags['cer-pp'] ?? 2),
    f1Pp: Number(flags['f1-pp'] ?? 2),
  };

  const baselineRecords = readJsonl(baselinePath);
  const candidateRecords = readJsonl(candidatePath);
  const baselineByKey = groupByKey(baselineRecords);
  const candidateByKey = groupByKey(candidateRecords);

  let anyFail = false;
  let comparedConfigs = 0;
  let sawF1 = false;

  console.log(`Baseline:  ${baselinePath} (${baselineRecords.length} record(s))`);
  console.log(`Candidate: ${candidatePath} (${candidateRecords.length} record(s))`);
  console.log(`Thresholds: p95 latency +${thresholds.latencyPct}%, CER +${thresholds.cerPp}pp, F1 -${thresholds.f1Pp}pp\n`);

  for (const [key, candList] of candidateByKey) {
    const baseList = baselineByKey.get(key);
    if (!baseList) continue; // config only present in candidate — nothing to diff against
    comparedConfigs++;

    // Compare most-recent-of-each (last record in file order) — a config
    // that appears more than once per file (e.g. re-run mid-session) is an
    // edge case this keeps simple rather than averaging silently.
    const baseline = baseList[baseList.length - 1];
    const candidate = candList[candList.length - 1];

    const findings = compareRecordPair(key, baseline, candidate, thresholds);
    if (findings.some(f => f.message.includes('F1 regression') || /f1/i.test(f.message))) sawF1 = true;

    if (findings.length) {
      console.log(`[${key}]`);
      for (const f of findings) {
        console.log(`  ${f.severity === 'fail' ? '✗ FAIL' : '⚠ WARN'}  ${f.message}`);
        if (f.severity === 'fail') anyFail = true;
      }
      console.log('');
    }
  }

  if (comparedConfigs === 0) {
    console.log('No matching (suite, config) pairs found between the two files — nothing to compare.');
  } else {
    console.log(`Compared ${comparedConfigs} matching config(s).`);
  }
  if (!sawF1) {
    console.log('(No F1 metric found in either file — detection quality/F1 scoring isn\'t implemented in this harness yet.)');
  }

  process.exit(anyFail ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
