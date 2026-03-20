/**
 * Performance metrics logger — writes structured JSON to .perf-log.jsonl
 * in the group workspace. Each line is a self-contained metric event.
 *
 * Metrics are versioned (buildId) so performance can be compared across deploys.
 * The host can aggregate these for dashboards or trend analysis.
 */

import fs from 'fs';
import path from 'path';

const WORKSPACE_GROUP = '/workspace/group';
const PERF_LOG_FILE = path.join(WORKSPACE_GROUP, '.perf-log.jsonl');
const MAX_LOG_LINES = 1000; // rotate after 1000 entries

export interface PerfMetric {
  type: 'startup' | 'classify' | 'response' | 'tool' | 'escalation' | 'error';
  buildId: string;
  timestamp: string;
  category?: string;
  error?: string;
  dissatisfied?: boolean;
  // Startup metrics
  startupMs?: number;
  ollamaWarmMs?: number;
  // Classify metrics
  classifyMs?: number;
  classifyMethod?: 'keyword' | 'secretary' | 'regex_fallback';
  // Response metrics
  model?: string;
  think?: boolean;
  taskType?: string;
  complexity?: string;
  promptChars?: number;
  responseChars?: number;
  responseMs?: number;
  historyMsgs?: number;
  toolRounds?: number;
  // Tool metrics
  toolName?: string;
  toolMs?: number;
  // Escalation
  fromModel?: string;
  toModel?: string;
  reason?: string;
}

export function logPerf(metric: PerfMetric): void {
  try {
    const line = JSON.stringify(metric) + '\n';
    fs.appendFileSync(PERF_LOG_FILE, line);

    // Rotate: if file is too large, trim to last MAX_LOG_LINES/2 entries
    try {
      const content = fs.readFileSync(PERF_LOG_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > MAX_LOG_LINES) {
        const trimmed = lines.slice(-Math.floor(MAX_LOG_LINES / 2));
        fs.writeFileSync(PERF_LOG_FILE, trimmed.join('\n') + '\n');
      }
    } catch { /* ignore rotation errors */ }
  } catch { /* ignore write errors */ }
}

/**
 * Read perf log entries, optionally filtered by build ID.
 * Returns parsed metrics in chronological order.
 */
export function readPerfLog(buildId?: string): PerfMetric[] {
  try {
    if (!fs.existsSync(PERF_LOG_FILE)) return [];
    const content = fs.readFileSync(PERF_LOG_FILE, 'utf-8');
    const entries = content.trim().split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as PerfMetric; } catch { return null; } })
      .filter((e): e is PerfMetric => e !== null);
    if (buildId) return entries.filter((e) => e.buildId === buildId);
    return entries;
  } catch { return []; }
}

/**
 * Summarize perf metrics for a given build ID.
 * Returns averages for key metrics.
 */
export function summarizePerf(buildId: string): Record<string, unknown> {
  const entries = readPerfLog(buildId);
  if (entries.length === 0) return { buildId, entries: 0 };

  const responses = entries.filter((e) => e.type === 'response' && e.responseMs);
  const classifies = entries.filter((e) => e.type === 'classify' && e.classifyMs);
  const startups = entries.filter((e) => e.type === 'startup' && e.startupMs);

  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const p95 = (arr: number[]) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)];
  };

  const responseTimes = responses.map((e) => e.responseMs!);
  const classifyTimes = classifies.map((e) => e.classifyMs!);

  return {
    buildId,
    entries: entries.length,
    responses: responses.length,
    avgResponseMs: avg(responseTimes),
    p95ResponseMs: p95(responseTimes),
    avgClassifyMs: avg(classifyTimes),
    avgStartupMs: avg(startups.map((e) => e.startupMs!)),
    modelBreakdown: responses.reduce((acc, e) => {
      const key = e.model || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    thinkRate: responses.length ? (responses.filter((e) => e.think).length / responses.length * 100).toFixed(1) + '%' : null,
    escalations: entries.filter((e) => e.type === 'escalation').length,
  };
}
