/**
 * Tests for the semantic routing and classification layer of the ollama-runner.
 *
 * Covers:
 *   - extractContent       — normalise Ollama message content to a plain string
 *   - selectModelFallback  — regex-based model selection (used when Secretary is unavailable)
 *   - shouldThinkFallback  — regex-based think-mode detection (used as fallback)
 *   - getEscalationTier    — pure escalation ladder logic
 *   - classifyMessage      — Secretary (qwen2.5:3b) semantic classifier
 *   - callOllama           — auto-escalation and secretary review-hint injection
 *
 * Adding a new test for each new model, task type, or routing rule keeps this file
 * as the canonical source of truth for routing behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// Mock fs before importing the module under test
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => '[]'),
    },
  };
});

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  extractContent,
  selectModelFallback,
  shouldThinkFallback,
  getEscalationTier,
  classifyMessage,
  detectTaskType,
  TASK_TEMPERATURE,
  callOllama,
  getSystemPrompt,
  type MessageClassification,
} from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Construct a minimal successful Ollama /api/chat text response. */
function ollamaTextResp(content: string) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      message: { role: 'assistant', content, tool_calls: undefined },
      done: true,
    }),
  };
}

/** Build a classifier response JSON string as the secretary would produce. */
function classifyJson(overrides: Partial<{
  model: string;
  think: boolean;
  complexity: string;
  task_type: string;
  needs_web: boolean;
  answer: string;
}> = {}): string {
  const defaults = { model: 'default', think: false, complexity: 'medium', task_type: 'chat' };
  return JSON.stringify({ ...defaults, ...overrides });
}

// ---------------------------------------------------------------------------
// extractContent
// ---------------------------------------------------------------------------

describe('extractContent', () => {
  it('returns string content unchanged', () => {
    expect(extractContent('hello world')).toBe('hello world');
  });

  it('joins array of strings', () => {
    expect(extractContent(['hello', ' ', 'world'])).toBe('hello world');
  });

  it('extracts text field from array of objects', () => {
    expect(extractContent([{ text: 'from object' }, { text: '!' }])).toBe('from object!');
  });

  it('handles mixed array (string + object)', () => {
    expect(extractContent(['prefix ', { text: 'suffix' }])).toBe('prefix suffix');
  });

  it('returns empty string for undefined / null / object', () => {
    expect(extractContent(undefined)).toBe('');
    expect(extractContent(null)).toBe('');
    expect(extractContent({})).toBe('');
    expect(extractContent(42)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractContent([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// TASK_TEMPERATURE
// ---------------------------------------------------------------------------

describe('TASK_TEMPERATURE', () => {
  it('creative tasks get the highest temperature', () => {
    const max = Math.max(...Object.values(TASK_TEMPERATURE));
    expect(TASK_TEMPERATURE.creative).toBe(max);
  });

  it('code and debug tasks get the lowest temperature', () => {
    expect(TASK_TEMPERATURE.code).toBeLessThanOrEqual(TASK_TEMPERATURE.chat);
    expect(TASK_TEMPERATURE.debug).toBeLessThanOrEqual(TASK_TEMPERATURE.chat);
    expect(TASK_TEMPERATURE.code).toBe(TASK_TEMPERATURE.debug);
  });

  it('covers all RichTaskType values', () => {
    const expected = ['chat', 'code', 'creative', 'analysis', 'decision', 'debug', 'research'] as const;
    for (const t of expected) {
      expect(TASK_TEMPERATURE[t]).toBeDefined();
      expect(typeof TASK_TEMPERATURE[t]).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// selectModelFallback
// ---------------------------------------------------------------------------

describe('selectModelFallback', () => {
  it('routes images to qwen2.5vl:72b regardless of text content', () => {
    expect(selectModelFallback('hello', true)).toBe('qwen2.5vl:72b');
    expect(selectModelFallback('write a function for me', true)).toBe('qwen2.5vl:72b');
  });

  it('routes coding prompts to qwen3-coder:30b', () => {
    expect(selectModelFallback('implement a binary search function')).toBe('qwen3-coder:30b');
    expect(selectModelFallback('refactor this code')).toBe('qwen3-coder:30b');
    expect(selectModelFallback('debug the following script')).toBe('qwen3-coder:30b');
    expect(selectModelFallback('write a function that parses JSON')).toBe('qwen3-coder:30b');
  });

  it('routes non-coding prompts to qwen3.5:35b', () => {
    expect(selectModelFallback('what is the weather like today?')).toBe('qwen3.5:35b');
    expect(selectModelFallback('tell me a joke')).toBe('qwen3.5:35b');
    expect(selectModelFallback('summarize the news')).toBe('qwen3.5:35b');
  });

  it('images override coding patterns', () => {
    // Even "write a function" with images goes to vision model
    expect(selectModelFallback('write a function from this diagram', true)).toBe('qwen2.5vl:72b');
  });
});

// ---------------------------------------------------------------------------
// shouldThinkFallback
// ---------------------------------------------------------------------------

describe('shouldThinkFallback', () => {
  it('triggers on explicit think words', () => {
    expect(shouldThinkFallback('think hard about this')).toBe(true);
    expect(shouldThinkFallback('step-by-step please')).toBe(true);
    expect(shouldThinkFallback('reason through this carefully')).toBe(true);
    expect(shouldThinkFallback('show your thinking')).toBe(true);
  });

  it('triggers on decision-making words', () => {
    expect(shouldThinkFallback('should I use React or Vue?')).toBe(true);
    expect(shouldThinkFallback('help me decide between postgres and mysql')).toBe(true);
    expect(shouldThinkFallback('pros and cons of microservices')).toBe(true);
  });

  it('does not trigger on everyday messages', () => {
    expect(shouldThinkFallback('what is the capital of France?')).toBe(false);
    expect(shouldThinkFallback('generate an image of a cat')).toBe(false);
    expect(shouldThinkFallback('hello, how are you?')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectTaskType
// ---------------------------------------------------------------------------

describe('detectTaskType', () => {
  it('returns "code" for coding verbs', () => {
    expect(detectTaskType('implement a sorting algorithm')).toBe('code');
    expect(detectTaskType('debug the following .py script')).toBe('code');
  });

  it('returns "creative" for creative writing requests', () => {
    expect(detectTaskType('write a poem about autumn')).toBe('creative');
    expect(detectTaskType('tell a story about a robot')).toBe('creative');
    // "tell me a story" doesn't match — verb must be immediately followed by optional "a" + noun
    expect(detectTaskType('tell me a story about a robot')).toBe('analysis');
  });

  it('returns "brainstorm" for ideation prompts', () => {
    expect(detectTaskType('brainstorm ideas for a startup')).toBe('brainstorm');
    expect(detectTaskType('give me 5 alternatives for this design')).toBe('brainstorm');
  });

  it('defaults to "analysis" for general questions', () => {
    expect(detectTaskType('what is machine learning?')).toBe('analysis');
    expect(detectTaskType('explain how TCP works')).toBe('analysis');
    expect(detectTaskType('good morning')).toBe('analysis');
  });
});

// ---------------------------------------------------------------------------
// getEscalationTier
// ---------------------------------------------------------------------------

describe('getEscalationTier', () => {
  it('coder escalates to analyst tier', () => {
    const next = getEscalationTier('qwen3-coder:30b', false);
    expect(next).toEqual({ model: 'qwen3.5:35b', think: true });
  });

  it('35b fast escalates to 35b+think (analyst)', () => {
    const next = getEscalationTier('qwen3.5:35b', false);
    expect(next).toEqual({ model: 'qwen3.5:35b', think: true });
  });

  it('35b+think escalates to deepseek-r1:70b (architect)', () => {
    const next = getEscalationTier('qwen3.5:35b', true);
    expect(next).toEqual({ model: 'deepseek-r1:70b', think: false });
  });

  it('deepseek-r1:70b is the maximum tier — returns null', () => {
    expect(getEscalationTier('deepseek-r1:70b', false)).toBeNull();
    expect(getEscalationTier('deepseek-r1:70b', true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------

describe('classifyMessage', () => {
  beforeEach(() => mockFetch.mockReset());

  it('skips fetch and returns vision classification when images are present', async () => {
    const cls = await classifyMessage('describe this image', true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(cls.model).toBe('qwen2.5vl:72b');
    expect(cls.think).toBe(false);
    expect(cls.complexity).toBe('low');
    expect(cls.taskTypeRich).toBe('analysis');
    expect(cls.usedSecretary).toBe(false); // image shortcut — secretary not called
  });

  it('maps "coder" → qwen3-coder:30b', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({ model: 'coder', task_type: 'code' })));
    const cls = await classifyMessage('write me a sort function', false);
    expect(cls.model).toBe('qwen3-coder:30b');
    expect(cls.taskTypeRich).toBe('code');
  });

  it('maps "analyst" → qwen3.5:35b with think=true', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({ model: 'analyst', task_type: 'decision' })));
    const cls = await classifyMessage('weigh the trade-offs of different DB schemas', false);
    expect(cls.model).toBe('qwen3.5:35b');
    expect(cls.think).toBe(true);
    expect(cls.taskTypeRich).toBe('decision');
  });

  it('maps "architect" → deepseek-r1:70b', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({ model: 'architect', task_type: 'analysis' })));
    const cls = await classifyMessage('design a globally distributed database', false);
    expect(cls.model).toBe('deepseek-r1:70b');
  });

  it('maps "artist" → qwen3.5:35b (artist handled via generate_art tool, not model swap)', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({ model: 'artist', task_type: 'creative' })));
    const cls = await classifyMessage('draw me a sunset', false);
    expect(cls.model).toBe('qwen3.5:35b');
  });

  it('pre-escalates high complexity + default model to think=true', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({ model: 'default', complexity: 'high', think: false })));
    const cls = await classifyMessage('explain the entire history of computing', false);
    expect(cls.think).toBe(true);
    expect(cls.model).toBe('qwen3.5:35b');
  });

  it('sets needsWeb=true when secretary flags needs_web', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({
      model: 'default',
      complexity: 'low',
      task_type: 'research',
      needs_web: true,
      answer: 'I think it is around $50k',
    })));
    const cls = await classifyMessage("what's the current price of bitcoin?", false);
    expect(cls.needsWeb).toBe(true);
  });

  it('sets needsWeb=false (or omits) for questions answerable from training data', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({
      model: 'default',
      complexity: 'low',
      needs_web: false,
    })));
    const cls = await classifyMessage('at what temperature does water boil?', false);
    expect(cls.needsWeb).toBeFalsy();
  });

  it('defaults needsWeb to false when secretary omits the field', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({
      model: 'default',
      complexity: 'low',
    })));
    const cls = await classifyMessage('how many days in a week?', false);
    expect(cls.needsWeb).toBeFalsy();
  });

  it('includes needs_web instruction in classify prompt', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    await classifyMessage('what is the capital of France?', false);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt: string = body.messages[0].content;
    expect(prompt).toContain('needs_web');
  });

  it('strips ```json ``` wrapper from secretary response', async () => {
    const wrapped = `\`\`\`json\n${classifyJson({ model: 'coder', task_type: 'code' })}\n\`\`\``;
    mockFetch.mockResolvedValueOnce(ollamaTextResp(wrapped));
    const cls = await classifyMessage('fix my code', false);
    expect(cls.model).toBe('qwen3-coder:30b');
  });

  it('falls back to regex when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const cls = await classifyMessage('implement a quicksort algorithm', false);
    // Regex fallback: coding pattern → coder
    expect(cls.model).toBe('qwen3-coder:30b');
    expect(cls.usedSecretary).toBe(false); // regex fallback — should not trigger grading
  });

  it('falls back to regex when secretary returns invalid JSON', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp('not valid json at all'));
    const cls = await classifyMessage('what is 2 + 2?', false);
    // Regex fallback: no coding pattern → 35b
    expect(cls.model).toBe('qwen3.5:35b');
  });

  it('falls back to regex when fetch returns non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' });
    const cls = await classifyMessage('explain quantum computing', false);
    expect(cls.model).toBe('qwen3.5:35b');
  });

  it('assigns correct temperature for each task type', async () => {
    const cases: Array<[string, number]> = [
      ['chat', TASK_TEMPERATURE.chat],
      ['code', TASK_TEMPERATURE.code],
      ['creative', TASK_TEMPERATURE.creative],
      ['analysis', TASK_TEMPERATURE.analysis],
      ['decision', TASK_TEMPERATURE.decision],
      ['debug', TASK_TEMPERATURE.debug],
      ['research', TASK_TEMPERATURE.research],
    ];
    for (const [task_type, expected] of cases) {
      mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({ task_type })));
      const cls = await classifyMessage('explain this concept in detail', false);
      expect(cls.temperature, `${task_type} temperature`).toBe(expected);
    }
  });

  it('sets usedSecretary=true on successful classify call', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson({ model: 'default' })));
    const cls = await classifyMessage('what should I do about this error?', false);
    expect(cls.usedSecretary).toBe(true);
  });

  it('uses the configured secretary model as the classifier', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    await classifyMessage('explain how this feature works', false);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('gemma3:4b');
  });

  it('sends classify call with low temperature and small context', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    await classifyMessage('test message', false);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.options.temperature).toBeLessThanOrEqual(0.1);
    expect(body.options.num_ctx).toBeLessThanOrEqual(4096);
  });
});

// ---------------------------------------------------------------------------
// callOllama — auto-escalation
// ---------------------------------------------------------------------------

describe('callOllama — auto-escalation', () => {
  const chatJid = 'tg-j:test';
  const groupFolder = 'test_group';
  const messages = [{ role: 'user' as const, content: 'help me' }];

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  it('auto-escalates when response contains failure phrase', async () => {
    // First call (35b): response triggers AUTO_ESCALATE_PATTERN
    mockFetch
      .mockResolvedValueOnce(ollamaTextResp("I apologize, I wasn't able to solve that."))
      // Escalated call (35b+think): returns clean answer
      .mockResolvedValueOnce(ollamaTextResp('Here is the solution.'));

    const result = await callOllama('qwen3.5:35b', messages, chatJid, groupFolder);

    // Should have made 2 calls: initial 35b + escalated 35b+think
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toBe('Here is the solution.');
  });

  it('does not auto-escalate on normal empathy phrases', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp("I'm sorry to hear that. Let me help you."));
    const result = await callOllama('qwen3.5:35b', messages, chatJid, groupFolder);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toContain("I'm sorry to hear that");
  });

  it('does not auto-escalate when already at max tier', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp("I apologize, I couldn't complete this task."));
    const result = await callOllama('deepseek-r1:70b', messages, chatJid, groupFolder);
    // deepseek-r1 is max tier — no escalation, returns the apology response
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toContain("I apologize");
  });
});

// ---------------------------------------------------------------------------
// callOllama — secretary review hint injection
// ---------------------------------------------------------------------------

describe('callOllama — secretary review hint', () => {
  const chatJid = 'tg-j:test';
  const groupFolder = 'test_group';

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  it('passes system messages through to the coordinator call', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp('Paris.'));

    const systemMsg = { role: 'system' as const, content: 'You are Jarvis.' };
    const userMsg = { role: 'user' as const, content: 'What is the capital of France?' };
    const messages = [systemMsg, userMsg];

    const result = await callOllama('qwen3.5:35b', messages, chatJid, groupFolder);
    expect(result).toBe('Paris.');

    const coordBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMessages = coordBody.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
    expect(systemMessages[0].content).toBe('You are Jarvis.');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — set_status
// ---------------------------------------------------------------------------

describe('handleToolCall — set_status', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls setStatus callback with italic-wrapped text', async () => {
    const { handleToolCall } = await import('./index.js');
    const setStatus = vi.fn();
    const result = await handleToolCall('set_status', { text: 'Thinking hard...' }, 'jid', 'group', setStatus);
    expect(setStatus).toHaveBeenCalledWith('_Thinking hard..._');
    expect(result).toBe('');
  });

  it('returns empty string without calling setStatus when no callback provided', async () => {
    const { handleToolCall } = await import('./index.js');
    const result = await handleToolCall('set_status', { text: 'status' }, 'jid', 'group');
    expect(result).toBe('');
  });

  it('does not call setStatus for empty text', async () => {
    const { handleToolCall } = await import('./index.js');
    const setStatus = vi.fn();
    await handleToolCall('set_status', { text: '' }, 'jid', 'group', setStatus);
    expect(setStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — get_help
// ---------------------------------------------------------------------------

describe('handleToolCall — get_help', () => {
  it('returns a non-empty string covering all major sections', async () => {
    const { handleToolCall } = await import('./index.js');
    const result = await handleToolCall('get_help', {}, 'jid', 'group');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(100);
    // Key sections that should always be present
    expect(result).toMatch(/image/i);
    expect(result).toMatch(/video/i);
    expect(result).toMatch(/code/i);
    expect(result).toMatch(/remind/i);
  });
});


// ---------------------------------------------------------------------------
// Trivial message fast path
// ---------------------------------------------------------------------------

describe('trivial message detection', () => {
  it('skips classification for greetings', async () => {
    const cls = await classifyMessage('hi jarvis', false);
    expect(cls.usedSecretary).toBe(false);
    expect(cls.taskTypeRich).toBe('chat');
    expect(cls.complexity).toBe('low');
  });

  it('skips classification for short acknowledgments', async () => {
    for (const msg of ['ok', 'thanks', 'cool', 'nice', 'yep', 'lol']) {
      const cls = await classifyMessage(msg, false);
      expect(cls.usedSecretary).toBe(false);
    }
  });

  it('does NOT skip classification for real questions', async () => {
    mockFetch.mockResolvedValueOnce(
      ollamaTextResp(classifyJson({ model: 'default', complexity: 'low' })),
    );
    const cls = await classifyMessage('what is the weather in tokyo?', false);
    expect(cls.usedSecretary).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Model-tool compatibility
// ---------------------------------------------------------------------------

describe('MODELS_WITHOUT_TOOLS', () => {
  it('secretary model is excluded from tool use', async () => {
    // gemma3:4b does not support structured tool calling — sending tools causes 400
    const { MODELS } = await import('./index.js');
    const MODELS_WITHOUT_TOOLS = new Set([MODELS.VISION, MODELS.SECRETARY]);
    expect(MODELS_WITHOUT_TOOLS.has(MODELS.SECRETARY)).toBe(true);
    expect(MODELS_WITHOUT_TOOLS.has(MODELS.VISION)).toBe(true);
    // Coordinator and coder DO support tools
    expect(MODELS_WITHOUT_TOOLS.has(MODELS.COORDINATOR)).toBe(false);
    expect(MODELS_WITHOUT_TOOLS.has(MODELS.CODER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin-only restrictions
// ---------------------------------------------------------------------------

describe('admin-only tool restrictions', () => {
  it('blocks run_command from group chats', async () => {
    const { handleToolCall } = await import('./index.js');
    const result = await handleToolCall('run_command', { command: 'ls' }, 'tg-j:-1003897457831', 'group');
    expect(result).toContain('admin');
    expect(result).toContain('Error');
  });

  it('blocks run_command from non-admin DMs', async () => {
    const { handleToolCall } = await import('./index.js');
    const result = await handleToolCall('run_command', { command: 'ls' }, 'tg-j:999999', 'group');
    expect(result).toContain('admin');
  });

  it('get_help shows admin section only for admin chat', async () => {
    const { handleToolCall } = await import('./index.js');
    const adminResult = await handleToolCall('get_help', {}, 'tg-j:365278370', 'group');
    const groupResult = await handleToolCall('get_help', {}, 'tg-j:-1003897457831', 'group');
    expect(adminResult).toContain('Admin only');
    expect(groupResult).not.toContain('Admin only');
  });

  it('system prompt excludes shell commands for non-admin chats', () => {
    const adminPrompt = getSystemPrompt('Jarvis', 'test_group', 'tg-j:365278370');
    const groupPrompt = getSystemPrompt('Jarvis', 'test_group', 'tg-j:-1003897457831');
    expect(adminPrompt).toContain('run_command');
    expect(groupPrompt).not.toContain('run_command');
  });
});

// ---------------------------------------------------------------------------
// PM-011 · Memory Quality — getSystemPrompt memory directives
// ---------------------------------------------------------------------------
// These tests verify that the system prompt contains the correct memory path,
// loads jarvis.md content when it exists, and includes all proactive update
// triggers. If any of these break, Jarvis's memory system stops working silently.

describe('getSystemPrompt — memory directives (PM-011)', () => {
  const mockFs = fs as unknown as {
    readFileSync: ReturnType<typeof vi.fn>;
    existsSync: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockFs.readFileSync.mockReturnValue('');
    mockFs.existsSync.mockReturnValue(false);
  });

  it('embeds the correct jarvis.md path for a given groupFolder', () => {
    const prompt = getSystemPrompt('Jarvis', 'telegram_main');
    expect(prompt).toContain('/workspace/extra/nanoclaw/groups/telegram_main/jarvis.md');
  });

  it('falls back to a default path when no groupFolder is given', () => {
    const prompt = getSystemPrompt('Jarvis');
    expect(prompt).toContain('/workspace/extra/nanoclaw/groups/jarvis.md');
    expect(prompt).not.toContain('undefined');
  });

  it('includes jarvis.md content in the prompt when the file exists', () => {
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (String(p).includes('jarvis.md')) return 'User prefers concise answers.';
      return '';
    });
    const prompt = getSystemPrompt('Jarvis', 'telegram_main');
    expect(prompt).toContain('User prefers concise answers.');
    expect(prompt).toContain('What I know about the user');
  });

  it('omits the jarvis.md section when the file is empty or missing', () => {
    mockFs.readFileSync.mockReturnValue('');
    const prompt = getSystemPrompt('Jarvis', 'telegram_main');
    expect(prompt).not.toContain('What I know about the user');
  });

  it('includes all five proactive memory update triggers', () => {
    const prompt = getSystemPrompt('Jarvis', 'telegram_main');
    // These are the exact triggers that drive proactive memory updates.
    // If any are missing, Jarvis will stop updating memory for that category.
    expect(prompt).toContain('User corrects you');
    expect(prompt).toContain('preference');
    expect(prompt).toContain('behaves unexpectedly');
    expect(prompt).toContain('project');
    expect(prompt).toContain('unusually good answer');
  });

  it('instructs Jarvis to update memory without being asked', () => {
    const prompt = getSystemPrompt('Jarvis', 'telegram_main');
    expect(prompt).toContain('Update proactively');
  });

  it('includes both memory sections (About the user + Learnings)', () => {
    const prompt = getSystemPrompt('Jarvis', 'telegram_main');
    expect(prompt).toContain('About the user');
    expect(prompt).toContain('Learnings');
  });

  it('injects the assistantName correctly', () => {
    const prompt = getSystemPrompt('Andy', 'telegram_main');
    expect(prompt).toContain('You are Andy');
  });
});

// ---------------------------------------------------------------------------
// PM-012 · Multi-Turn Context Coherence Across Escalation Tiers
// ---------------------------------------------------------------------------
// These tests verify that when callOllama escalates — whether via the escalate
// tool call or auto-escalation — the full conversation history is passed to the
// next tier unchanged. Losing history mid-escalation means the user has to
// re-explain themselves to what feels like a different agent.

describe('callOllama — context coherence across escalation (PM-012)', () => {
  beforeEach(() => mockFetch.mockReset());

  const multiTurnHistory = [
    { role: 'system' as const, content: 'You are Jarvis.' },
    { role: 'user' as const, content: 'My name is DJ.' },
    { role: 'assistant' as const, content: 'Nice to meet you, DJ.' },
    { role: 'user' as const, content: 'Now solve this hard problem.' },
  ];

  it('passes full message history to the escalated tier on tool-call escalation', async () => {
    // First call: 35b returns an escalate tool call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'escalate', arguments: { reason: 'too hard' } } }],
        },
        done: true,
      }),
    });
    // Second call: deepseek responds
    mockFetch.mockResolvedValueOnce(ollamaTextResp('Here is the solution.'));

    await callOllama('qwen3.5:35b', multiTurnHistory, 'tg:123', 'test-group');

    // The escalated (second) fetch should have received all 4 messages
    const escalatedBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(escalatedBody.messages).toHaveLength(multiTurnHistory.length);
    expect(escalatedBody.messages[1].content).toBe('My name is DJ.');
    expect(escalatedBody.messages[2].content).toBe('Nice to meet you, DJ.');
  });

  it('passes full message history on auto-escalation (failure phrase detected)', async () => {
    // First call: 35b responds with a failure phrase triggering auto-escalation
    mockFetch.mockResolvedValueOnce(ollamaTextResp("I apologize, I wasn't able to complete this task."));
    // Second call: escalated tier responds
    mockFetch.mockResolvedValueOnce(ollamaTextResp('Here is the correct solution.'));

    await callOllama('qwen3.5:35b', multiTurnHistory, 'tg:123', 'test-group');

    const escalatedBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(escalatedBody.messages).toHaveLength(multiTurnHistory.length);
    // Earlier turns must be intact — Jarvis must remember DJ's name after escalation
    expect(escalatedBody.messages[1].content).toBe('My name is DJ.');
  });

  it('does not escalate beyond the maximum tier', async () => {
    // deepseek-r1:70b returns an escalate tool call — ignored at max tier;
    // a follow-up is sent to the SAME model (not a higher one)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'escalate', arguments: { reason: 'still too hard' } } }],
        },
        done: true,
      }),
    });
    // Follow-up call — same model continues
    mockFetch.mockResolvedValueOnce(ollamaTextResp('This is my best answer at max tier.'));

    const result = await callOllama('deepseek-r1:70b', multiTurnHistory, 'tg:123', 'test-group');

    // Both calls must use deepseek-r1:70b — never a higher model
    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body.model).toBe('deepseek-r1:70b');
    }
    expect(result).toContain('This is my best answer at max tier.');
  });

  it('preserves system message at position 0 after escalation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'escalate', arguments: { reason: 'hard' } } }],
        },
        done: true,
      }),
    });
    mockFetch.mockResolvedValueOnce(ollamaTextResp('Done.'));

    await callOllama('qwen3.5:35b', multiTurnHistory, 'tg:123', 'test-group');

    const escalatedBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(escalatedBody.messages[0].role).toBe('system');
    expect(escalatedBody.messages[0].content).toBe('You are Jarvis.');
  });

  it('coder escalates directly to analyst tier (qwen3.5:35b+think), not architect', async () => {
    // Coder returns escalate tool call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'escalate', arguments: { reason: 'complex architecture' } } }],
        },
        done: true,
      }),
    });
    mockFetch.mockResolvedValueOnce(ollamaTextResp('Architect response.'));

    await callOllama('qwen3-coder:30b', multiTurnHistory, 'tg:123', 'test-group');

    const escalatedBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    // Must escalate to 35b+think (analyst), not deepseek
    expect(escalatedBody.model).toBe('qwen3.5:35b');
    expect(escalatedBody.think).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routing handoff — force tags, secretary classification, and art pipeline
// ---------------------------------------------------------------------------

describe('routing handoffs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  // --- Force-route tags ---

  it('(think) tag routes to coordinator+think', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    const cls = await classifyMessage('(think) explain quantum computing', false);
    expect(cls.model).toBe('qwen3.5:35b');
    expect(cls.think).toBe(true);
    expect(cls.usedSecretary).toBe(false); // force tag bypasses secretary
  });

  it('(analyst) tag routes to coordinator+think', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    const cls = await classifyMessage('(analyst) compare these approaches', false);
    expect(cls.model).toBe('qwen3.5:35b');
    expect(cls.think).toBe(true);
  });

  it('(coder) tag routes to coder model', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    const cls = await classifyMessage('(coder) write a function', false);
    expect(cls.model).toBe('qwen3-coder:30b');
    expect(cls.think).toBe(false);
  });

  it('(architect) tag routes to architect+think', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    const cls = await classifyMessage('(architect) design the system', false);
    expect(cls.model).toBe('deepseek-r1:70b');
    expect(cls.think).toBe(true);
  });

  it('(deep) tag routes to architect', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    const cls = await classifyMessage('(deep) think about this really hard', false);
    expect(cls.model).toBe('deepseek-r1:70b');
    expect(cls.think).toBe(true);
  });

  it('(fast) tag routes to secretary model', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    const cls = await classifyMessage('(fast) what time is it', false);
    expect(cls.model).toBe('gemma3:4b');
    expect(cls.think).toBe(false);
  });

  it('force tags are case insensitive', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(classifyJson()));
    const cls = await classifyMessage('(THINK) explain this', false);
    expect(cls.think).toBe(true);
  });

  // --- Secretary routing ---

  it('secretary artist classification does NOT enable think mode', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(
      classifyJson({ model: 'artist', think: true, task_type: 'creative' }),
    ));
    const cls = await classifyMessage('draw me a sunset', false);
    expect(cls.model).toBe('qwen3.5:35b'); // coordinator handles art delegation
    expect(cls.think).toBe(false); // art doesn't need reasoning overhead
  });

  it('secretary coder classification routes to coder model', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(
      classifyJson({ model: 'coder', task_type: 'code' }),
    ));
    const cls = await classifyMessage('write a Python function to sort a list', false);
    expect(cls.model).toBe('qwen3-coder:30b');
  });

  it('secretary analyst classification enables think mode', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResp(
      classifyJson({ model: 'analyst', task_type: 'analysis', complexity: 'high' }),
    ));
    const cls = await classifyMessage('analyze the tradeoffs between React and Vue', false);
    expect(cls.model).toBe('qwen3.5:35b');
    expect(cls.think).toBe(true);
  });

  // --- Vague vs detailed creative requests ---

  it('vague art request does NOT match CREATIVE_PATTERN (routes to chat)', async () => {
    // Secretary fallback path — CREATIVE_PATTERN should NOT match bare requests
    const { detectRichTaskType } = await import('./index.js');
    expect(detectRichTaskType('draw me a picture')).not.toBe('creative');
    expect(detectRichTaskType('can you make an image please')).not.toBe('creative');
    expect(detectRichTaskType('generate an image for me')).not.toBe('creative');
  });

  it('detailed art request DOES match CREATIVE_PATTERN', async () => {
    const { detectRichTaskType } = await import('./index.js');
    expect(detectRichTaskType('draw a picture of a sunset over the ocean')).toBe('creative');
    expect(detectRichTaskType('generate an image of a cat wearing a hat')).toBe('creative');
    expect(detectRichTaskType('write a poem about love and loss')).toBe('creative');
  });

  // --- Image routing should NOT use images for non-vision force tags ---

  it('images route to vision model regardless of text', async () => {
    const cls = await classifyMessage('just a random message', true);
    expect(cls.model).toBe('qwen2.5vl:72b');
  });
});

// ---------------------------------------------------------------------------
// buildRouteHint — verify routing hints for coordinator
// ---------------------------------------------------------------------------

describe('buildRouteHint', () => {
  it('creative tasks include generate_art instruction', async () => {
    const { buildRouteHint } = await import('./index.js');
    const hint = buildRouteHint('draw a picture of a sunset over the ocean', false);
    expect(hint).toContain('generate_art');
    expect(hint).toContain('creative');
  });

  it('code tasks suggest coder delegation', async () => {
    const { buildRouteHint } = await import('./index.js');
    const hint = buildRouteHint('write a function to sort arrays', false);
    expect(hint).toContain('coder');
  });

  it('web-needing tasks include web_search instruction', async () => {
    const { buildRouteHint } = await import('./index.js');
    const hint = buildRouteHint('what is the weather in Tokyo today', false);
    expect(hint).toContain('web_search');
  });

  it('image attachments flag vision task', async () => {
    const { buildRouteHint } = await import('./index.js');
    const hint = buildRouteHint('describe this', true);
    expect(hint).toContain('vision');
  });
});

// ---------------------------------------------------------------------------
// callOllama — tool call completion (ensure follow-through)
// ---------------------------------------------------------------------------

describe('callOllama — tool call follow-through', () => {
  const chatJid = 'tg-j:test';
  const groupFolder = 'test_group';

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.readFileSync).mockReturnValue('[]');
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('executes tool calls and feeds results back to model for a complete response', async () => {
    const messages = [{ role: 'user' as const, content: 'draw a picture of a sunset over the ocean' }];

    // Round 1: model returns a tool call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'generate_art',
              arguments: { request: 'a sunset over the ocean' },
            },
          }],
        },
      }),
    });

    // Tool execution (generate_art calls the artist model)
    mockFetch.mockResolvedValueOnce(ollamaTextResp(
      JSON.stringify({ prompt: 'golden sunset over a calm ocean', backend: 'comfyui', use_reference: false }),
    ));

    // Round 2: model gets tool result and produces final response
    mockFetch.mockResolvedValueOnce(ollamaTextResp(
      'Here is the Artist\'s plan for your sunset image...',
    ));

    const result = await callOllama('qwen3.5:35b', messages, chatJid, groupFolder);

    // Must have made 3 calls: initial → tool execution → follow-up with tool result
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result).toContain('Artist');
  });

  it('returns final response even when tool call errors', async () => {
    const messages = [{ role: 'user' as const, content: 'what is 2+2' }];

    // Round 1: model calls a tool that will fail
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'web_search',
              arguments: { query: 'test' },
            },
          }],
        },
      }),
    });

    // web_search backend call fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' });

    // Follow-up: model gets tool error and responds anyway
    mockFetch.mockResolvedValueOnce(ollamaTextResp('The answer is 4.'));

    const result = await callOllama('qwen3.5:35b', messages, chatJid, groupFolder);
    expect(result).toContain('4');
  });
});
