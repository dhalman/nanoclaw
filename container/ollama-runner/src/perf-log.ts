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
  type: 'startup' | 'classify' | 'response' | 'tool' | 'escalation' | 'error' | 'feedback';
  traceId?: string; // links all perf entries for a single request
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
  classifyMethod?: 'keyword' | 'secretary' | 'regex_fallback' | 'trivial';
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
  // Reasoning metadata
  reasoningChars?: number;
  // Routing assessment
  routingModel?: string;    // which model classified the request
  routedTo?: string;        // which model was selected to handle it
  routingCorrect?: boolean; // retroactively set by post-mortem
  routingReason?: string;   // why routing may have been wrong
  // Tool metrics
  toolName?: string;
  toolMs?: number;
  // Escalation
  fromModel?: string;
  toModel?: string;
  reason?: string;
  // Prompt/response excerpts for correlating routing with content
  promptExcerpt?: string;
  responseExcerpt?: string;
  // User feedback (👎 reactions, corrections)
  feedbackType?: 'negative_reaction' | 'correction' | 'positive_reaction';
  feedbackContext?: string; // excerpt of the message that got feedback
  userId?: string;
}

const PERF_VERBOSE = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'verbose';

export function logPerf(metric: PerfMetric): void {
  try {
    // In production, strip large excerpts to keep perf log lean
    const entry = PERF_VERBOSE ? metric : {
      ...metric,
      promptExcerpt: metric.promptExcerpt?.slice(0, 60),
      responseExcerpt: metric.type === 'response' ? metric.responseExcerpt?.slice(0, 80) : undefined,
      feedbackContext: metric.feedbackContext?.slice(0, 80),
    };
    // Remove undefined values to keep JSON clean
    const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
    const line = JSON.stringify(clean) + '\n';
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

/**
 * Generate a trace ID for a request.
 */
export function newTraceId(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Get all perf entries for a trace ID — shows the full handoff sequence.
 */
export function getTrace(traceId: string): PerfMetric[] {
  return readPerfLog().filter((e) => e.traceId === traceId);
}

/**
 * Get the last N request traces with their full sequences.
 * Returns traces grouped by traceId, most recent first.
 */
export function getRecentTraces(count: number = 5): Array<{ traceId: string; entries: PerfMetric[] }> {
  const all = readPerfLog();
  // Group by traceId
  const grouped = new Map<string, PerfMetric[]>();
  for (const e of all) {
    if (!e.traceId) continue;
    const arr = grouped.get(e.traceId) || [];
    arr.push(e);
    grouped.set(e.traceId, arr);
  }
  // Sort by timestamp of first entry, return most recent N
  return [...grouped.entries()]
    .sort((a, b) => {
      const ta = a[1][0]?.timestamp || '';
      const tb = b[1][0]?.timestamp || '';
      return tb.localeCompare(ta);
    })
    .slice(0, count)
    .map(([traceId, entries]) => ({ traceId, entries }));
}

/**
 * Format a trace into a human-readable handoff sequence.
 */
export function formatTrace(entries: PerfMetric[]): string {
  if (entries.length === 0) return 'No trace entries found.';
  const lines: string[] = [];
  for (const e of entries) {
    const ts = e.timestamp?.slice(11, 19) || '?';
    switch (e.type) {
      case 'classify':
        lines.push(`${ts} 📋 Classify: ${e.routingModel || '?'} → ${e.routedTo || '?'} (${e.classifyMs || 0}ms) | ${e.routingReason || ''}`);
        break;
      case 'response':
        lines.push(`${ts} 💬 Response: ${e.routedTo || e.model || '?'} | ${e.responseMs || 0}ms | ${e.promptChars || 0}→${e.responseChars || 0} chars${e.dissatisfied ? ' ⚠️ dissatisfied' : ''}`);
        if (e.promptExcerpt) lines.push(`       prompt: "${e.promptExcerpt}"`);
        if (e.responseExcerpt) lines.push(`       response: "${e.responseExcerpt.slice(0, 100)}"`);
        break;
      case 'tool':
        lines.push(`${ts} 🔧 Tool: ${e.toolName || '?'} (${e.toolMs || 0}ms)`);
        if (e.responseExcerpt) lines.push(`       result: "${e.responseExcerpt.slice(0, 100)}"`);
        break;
      case 'escalation':
        lines.push(`${ts} ⬆️ Escalation: ${e.fromModel || '?'} → ${e.toModel || '?'} | ${e.reason || ''}`);
        break;
      case 'error':
        lines.push(`${ts} ❌ Error: ${e.category || '?'} — ${e.error || ''}`);
        break;
      case 'feedback':
        lines.push(`${ts} 👎 Feedback: ${e.feedbackType || '?'}`);
        break;
      default:
        lines.push(`${ts} ${e.type}`);
    }
  }
  return lines.join('\n');
}
