/**
 * Performance metrics logger — writes structured JSON to .perf-log.jsonl
 * in the group workspace. Each line is a self-contained metric event.
 *
 * Metrics are versioned (buildId) so performance can be compared across deploys.
 * The host can aggregate these for dashboards or trend analysis.
 */
export interface PerfMetric {
    type: 'startup' | 'classify' | 'response' | 'tool' | 'escalation';
    buildId: string;
    timestamp: string;
    startupMs?: number;
    ollamaWarmMs?: number;
    classifyMs?: number;
    classifyMethod?: 'keyword' | 'secretary' | 'regex_fallback';
    model?: string;
    think?: boolean;
    taskType?: string;
    complexity?: string;
    promptChars?: number;
    responseChars?: number;
    responseMs?: number;
    historyMsgs?: number;
    toolRounds?: number;
    toolName?: string;
    toolMs?: number;
    fromModel?: string;
    toModel?: string;
    reason?: string;
}
export declare function logPerf(metric: PerfMetric): void;
/**
 * Read perf log entries, optionally filtered by build ID.
 * Returns parsed metrics in chronological order.
 */
export declare function readPerfLog(buildId?: string): PerfMetric[];
/**
 * Summarize perf metrics for a given build ID.
 * Returns averages for key metrics.
 */
export declare function summarizePerf(buildId: string): Record<string, unknown>;
