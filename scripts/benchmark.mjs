#!/usr/bin/env node
/**
 * Model benchmark — compares latency, accuracy, quality, speed, and efficiency
 * across task types for multiple Ollama models.
 *
 * Usage:
 *   node scripts/benchmark.mjs [--skip-pull] [--skip-judge] [--quick] [--models a,b]
 *
 *   --skip-pull   don't pull missing models
 *   --skip-judge  skip LLM quality scoring (faster)
 *   --quick       1 prompt per category instead of 2
 *   --models      comma-separated list of model labels to include (e.g. --models 35b,35b+think)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const ARGS = process.argv.slice(2);
const SKIP_PULL  = ARGS.includes('--skip-pull');
const SKIP_JUDGE = ARGS.includes('--skip-judge');
const QUICK      = ARGS.includes('--quick');
const MODELS_ARG = (() => { const i = ARGS.indexOf('--models'); return i !== -1 ? ARGS[i+1]?.split(',') : null; })();

// ─── Models ──────────────────────────────────────────────────────────────────

const ALL_MODELS = [
  { id: 'qwen3.5:27b',      think: false, label: '27b'         },
  { id: 'qwen3.5:27b',      think: true,  label: '27b+think'   },
  { id: 'qwen3.5:35b',      think: false, label: '35b'         },
  { id: 'qwen3.5:35b',      think: true,  label: '35b+think'   },
  { id: 'deepseek-r1:32b',  think: false, label: 'dsr1:32b'    },
  { id: 'deepseek-v3:37b',  think: false, label: 'dsv3:37b'    },
];

const MODELS = MODELS_ARG
  ? ALL_MODELS.filter(m => MODELS_ARG.some(a => m.label.includes(a)))
  : ALL_MODELS;

// ─── Test suite ───────────────────────────────────────────────────────────────

const SUITE = [
  { category: 'fast', prompts: [
    { name: 'unit-convert', prompt: 'Convert 100°F to Celsius. Reply with only the numeric result and unit, nothing else.', check: r => r.includes('37') },
    { name: 'capital',      prompt: 'What is the capital of Australia? Reply with the city name only.', check: r => /canberra/i.test(r) },
  ]},
  { category: 'analysis', prompts: [
    { name: 'tcp-udp',     prompt: 'Explain the key differences between TCP and UDP. Use 3 bullet points.' },
    { name: 'oop-pillars', prompt: 'List the 4 pillars of object-oriented programming, each with a one-sentence explanation.' },
  ]},
  { category: 'code', prompts: [
    { name: 'binary-search', prompt: 'Write a binary search function in Python. Return code only — no explanation, no markdown prose.' },
    { name: 'debounce',      prompt: 'Write a debounce function in JavaScript. Return code only — no explanation, no markdown prose.' },
  ]},
  { category: 'creative', prompts: [
    { name: 'poem',       prompt: 'Write a short poem (4–6 lines) about autumn rain.' },
    { name: 'story-hook', prompt: 'Write exactly 2 sentences: a story hook about a robot that learns to paint.' },
  ]},
  { category: 'math', prompts: [
    { name: 'algebra',  prompt: 'Solve for x: 2x + 5 = 17. Show your work.', check: r => /x\s*=\s*6/.test(r) },
    { name: 'trains',   prompt: 'Two trains 1000 miles apart travel toward each other at 60 mph and 80 mph. How many hours until they meet? Show work.', check: r => /7\.1|50\/7|500\/70/.test(r) },
  ]},
  { category: 'reasoning', prompts: [
    { name: 'logic',    prompt: 'All mammals are warm-blooded. Dolphins are mammals. Whales are mammals. Are both warm-blooded? Answer yes/no then explain.', check: r => /^yes/i.test(r.trim()) },
    { name: 'tradeoff', prompt: 'Should a 2-person startup use microservices or a monolith for their MVP? Give 3 reasons for your recommendation.' },
  ]},
];

const prompts = QUICK
  ? SUITE.map(s => ({ ...s, prompts: s.prompts.slice(0, 1) }))
  : SUITE;

// ─── Ollama helpers ───────────────────────────────────────────────────────────

async function ollamaChat(model, messages, think = false) {
  const isQwen3 = model.startsWith('qwen3') && !model.includes('coder');
  const body = {
    model,
    messages,
    stream: false,
    ...(isQwen3 && think ? { think: true } : {}),
  };
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function pullModel(modelId) {
  console.log(`  Pulling ${modelId}...`);
  const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId, stream: false }),
  });
  if (!res.ok) throw new Error(`Pull failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log(`  ${modelId}: ${data.status}`);
}

async function listModels() {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  const data = await res.json();
  return (data.models || []).map(m => m.name);
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function extractThinking(content, thinkingField) {
  if (thinkingField) return { thinking: thinkingField, response: content };
  // deepseek-r1 embeds <think>...</think> in content
  const m = content.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
  if (m) return { thinking: m[1].trim(), response: m[2].trim() };
  return { thinking: '', response: content };
}

function computeMetrics(data, think) {
  const totalNs    = data.total_duration    ?? 0;
  const loadNs     = data.load_duration     ?? 0;
  const promptNs   = data.prompt_eval_duration ?? 0;
  const evalNs     = data.eval_duration     ?? 0;
  const promptTok  = data.prompt_eval_count ?? 0;
  const evalTok    = data.eval_count        ?? 0;

  const content   = typeof data.message?.content === 'string' ? data.message.content : '';
  const { thinking, response } = extractThinking(content, data.message?.thinking);

  const genTimeSec  = evalNs / 1e9;
  const totalTimeSec = totalNs / 1e9;
  const tokPerSec   = genTimeSec > 0 ? evalTok / genTimeSec : 0;
  const thinkTok    = Math.round(thinking.length / 4); // rough estimate
  const totalTok    = promptTok + evalTok;

  return {
    response,
    thinking,
    totalTimeSec,
    loadTimeSec: loadNs / 1e9,
    promptTimeSec: promptNs / 1e9,
    genTimeSec,
    promptTok,
    evalTok,
    thinkTok,
    totalTok,
    tokPerSec,
    // "cost" = total time × total tokens (higher = more expensive)
    cost: totalTimeSec * totalTok,
  };
}

// ─── LLM judge ───────────────────────────────────────────────────────────────

async function judgeResponse(prompt, response, category) {
  const judgePrompt = `You are an evaluator. Rate the following AI response on a scale of 1-10.

Category: ${category}
User prompt: ${prompt}
Response: ${response}

Score criteria:
- Accuracy: is the information correct?
- Completeness: does it fully answer the question?
- Clarity: is it well-written and easy to understand?
- Conciseness: does it avoid unnecessary padding?

Reply with ONLY a JSON object: {"score": <1-10>, "reason": "<one sentence>"}`;

  try {
    const data = await ollamaChat('qwen3.5:35b', [{ role: 'user', content: judgePrompt }], false);
    const text = typeof data.message?.content === 'string' ? data.message.content : '';
    const match = text.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { score: parsed.score ?? 5, reason: parsed.reason ?? '' };
    }
  } catch {}
  return { score: 5, reason: 'judge failed' };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m',
};

function pad(str, n, right = false) {
  const s = String(str ?? '');
  return right ? s.padStart(n) : s.padEnd(n);
}

function colorNum(val, low, high, fmt = v => v.toFixed(1)) {
  const s = fmt(val);
  if (val >= high) return C.green + s + C.reset;
  if (val <= low)  return C.red   + s + C.reset;
  return C.yellow + s + C.reset;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}NanoClaw Model Benchmark${C.reset}`);
  console.log(`Models: ${MODELS.map(m => m.label).join(', ')}`);
  console.log(`Prompts: ${prompts.flatMap(s => s.prompts).length} × ${MODELS.length} models = ${prompts.flatMap(s => s.prompts).length * MODELS.length} inferences\n`);

  // Pull missing models
  if (!SKIP_PULL) {
    const installed = await listModels();
    for (const m of MODELS) {
      const id = m.id.includes(':') ? m.id : m.id + ':latest';
      if (!installed.some(n => n === id || n === m.id)) {
        console.log(`${C.yellow}Pulling ${m.id}...${C.reset}`);
        await pullModel(m.id);
      }
    }
  }

  // Results store: results[modelLabel][category][promptName] = { metrics, accuracy, judge }
  const results = {};
  for (const m of MODELS) results[m.label] = {};

  const totalRuns = MODELS.length * prompts.flatMap(s => s.prompts).length;
  let runIdx = 0;

  // Run benchmarks
  for (const { category, prompts: catPrompts } of prompts) {
    console.log(`\n${C.bold}── ${category.toUpperCase()} ──${C.reset}`);
    for (const { name, prompt, check } of catPrompts) {
      console.log(`  ${C.dim}${name}${C.reset}: "${prompt.slice(0, 60)}..."`);
      for (const model of MODELS) {
        runIdx++;
        process.stdout.write(`    [${runIdx}/${totalRuns}] ${pad(model.label, 14)} `);
        const t0 = Date.now();
        try {
          const data = await ollamaChat(model.id, [{ role: 'user', content: prompt }], model.think);
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          const metrics = computeMetrics(data, model.think);
          const accuracy = check ? check(metrics.response) : null;

          if (!results[model.label][category]) results[model.label][category] = {};
          results[model.label][category][name] = { metrics, accuracy, prompt, response: metrics.response };

          const accStr = accuracy === null ? '' : accuracy ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
          console.log(`${elapsed}s | ${metrics.evalTok} tok | ${metrics.tokPerSec.toFixed(0)} tok/s ${accStr}`);
        } catch (err) {
          console.log(`${C.red}ERROR: ${err.message}${C.reset}`);
          if (!results[model.label][category]) results[model.label][category] = {};
          results[model.label][category][name] = { metrics: null, accuracy: false, error: err.message };
        }
      }
    }
  }

  // Quality judge pass
  if (!SKIP_JUDGE) {
    console.log(`\n${C.bold}── QUALITY JUDGE (qwen3.5:35b) ──${C.reset}`);
    for (const { category, prompts: catPrompts } of prompts) {
      for (const { name, prompt } of catPrompts) {
        console.log(`  ${C.dim}judging ${category}/${name}${C.reset}`);
        for (const model of MODELS) {
          const entry = results[model.label]?.[category]?.[name];
          if (!entry?.metrics) continue;
          process.stdout.write(`    ${pad(model.label, 14)} `);
          const j = await judgeResponse(prompt, entry.metrics.response, category);
          entry.judge = j;
          console.log(`score: ${colorNum(j.score, 5, 8, v => v.toFixed(0))}/10 — ${C.dim}${j.reason}${C.reset}`);
        }
      }
    }
  }

  // ── Summary tables ──────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(100)}`);
  console.log(`${C.bold}RESULTS SUMMARY${C.reset}`);
  console.log('═'.repeat(100));

  // Per-category table
  for (const { category, prompts: catPrompts } of prompts) {
    console.log(`\n${C.bold}${category.toUpperCase()}${C.reset}`);
    const cols = ['Model', 'Avg time (s)', 'Tok/s', 'Gen tok', 'Think tok', 'Accuracy', 'Quality', 'Cost'];
    const widths = [15, 13, 8, 9, 10, 10, 9, 10];
    console.log(cols.map((c, i) => pad(c, widths[i])).join('  '));
    console.log('─'.repeat(100));

    for (const model of MODELS) {
      const catResults = results[model.label]?.[category];
      if (!catResults) continue;
      const runs = Object.values(catResults).filter(r => r.metrics);
      if (!runs.length) continue;

      const avgTime   = runs.reduce((s, r) => s + r.metrics.totalTimeSec, 0) / runs.length;
      const avgTokS   = runs.reduce((s, r) => s + r.metrics.tokPerSec, 0) / runs.length;
      const avgGenTok = runs.reduce((s, r) => s + r.metrics.evalTok, 0) / runs.length;
      const avgThink  = runs.reduce((s, r) => s + r.metrics.thinkTok, 0) / runs.length;
      const avgCost   = runs.reduce((s, r) => s + r.metrics.cost, 0) / runs.length;
      const accRuns   = runs.filter(r => r.accuracy !== null);
      const accuracy  = accRuns.length ? `${accRuns.filter(r => r.accuracy).length}/${accRuns.length}` : 'n/a';
      const judgeRuns = runs.filter(r => r.judge);
      const quality   = judgeRuns.length ? (judgeRuns.reduce((s, r) => s + r.judge.score, 0) / judgeRuns.length).toFixed(1) : 'n/a';

      const row = [
        model.label,
        avgTime.toFixed(2),
        avgTokS.toFixed(0),
        avgGenTok.toFixed(0),
        avgThink > 0 ? avgThink.toFixed(0) : '-',
        accuracy,
        quality,
        avgCost.toFixed(0),
      ];
      console.log(row.map((v, i) => pad(v, widths[i])).join('  '));
    }
  }

  // Overall summary
  console.log(`\n${C.bold}OVERALL (all categories)${C.reset}`);
  const cols = ['Model', 'Avg time (s)', 'Tok/s', 'Accuracy', 'Quality', 'Avg cost', 'Think%'];
  const widths = [15, 13, 8, 10, 9, 10, 8];
  console.log(cols.map((c, i) => pad(c, widths[i])).join('  '));
  console.log('─'.repeat(90));

  for (const model of MODELS) {
    const allRuns = Object.values(results[model.label] ?? {}).flatMap(c => Object.values(c)).filter(r => r.metrics);
    if (!allRuns.length) continue;

    const avgTime   = allRuns.reduce((s, r) => s + r.metrics.totalTimeSec, 0) / allRuns.length;
    const avgTokS   = allRuns.reduce((s, r) => s + r.metrics.tokPerSec, 0) / allRuns.length;
    const avgCost   = allRuns.reduce((s, r) => s + r.metrics.cost, 0) / allRuns.length;
    const accRuns   = allRuns.filter(r => r.accuracy !== null);
    const accuracy  = accRuns.length ? `${accRuns.filter(r => r.accuracy).length}/${accRuns.length}` : 'n/a';
    const judgeRuns = allRuns.filter(r => r.judge);
    const quality   = judgeRuns.length ? (judgeRuns.reduce((s, r) => s + r.judge.score, 0) / judgeRuns.length).toFixed(1) : 'n/a';
    const thinkPct  = allRuns.some(r => r.metrics.thinkTok > 0)
      ? `${(allRuns.filter(r => r.metrics.thinkTok > 0).length / allRuns.length * 100).toFixed(0)}%`
      : '-';

    console.log([model.label, avgTime.toFixed(2), avgTokS.toFixed(0), accuracy, quality, avgCost.toFixed(0), thinkPct]
      .map((v, i) => pad(v, widths[i])).join('  '));
  }

  // Save raw results
  const outDir = join(__dirname, '..', 'data');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outFile, JSON.stringify({ models: MODELS, results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n${C.dim}Raw results saved to ${outFile}${C.reset}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
