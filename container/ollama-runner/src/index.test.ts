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
  isImageModel,
  resolveModel,
  MODEL_ALIASES,
  IMAGE_MODELS,
  handleToolCall,
  callOllama,
  classifyMessage,
  buildRouteHint,
  detectTaskType,
  detectNeedsWeb,
  estimateComplexity,
  shouldThinkFallback,
  selectModelFallback,
  getEscalationTier,
  MODELS,
} from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ollamaTextResponse(content: string) {
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

function ollamaToolCallResponse(toolName: string, args: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: toolName, arguments: args } }],
      },
      done: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// isImageModel
// ---------------------------------------------------------------------------

describe('isImageModel', () => {
  it.each(IMAGE_MODELS)('returns true for model containing "%s"', (keyword) => {
    expect(isImageModel(keyword)).toBe(true);
    expect(isImageModel(`x/${keyword}2-klein:latest`)).toBe(true);
    expect(isImageModel(keyword.toUpperCase())).toBe(true);
  });

  it('returns false for text models', () => {
    expect(isImageModel('llama3.2')).toBe(false);
    expect(isImageModel('qwen3-coder:30b')).toBe(false);
    expect(isImageModel('mistral')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

describe('resolveModel', () => {
  it.each(Object.entries(MODEL_ALIASES))('resolves "%s" → "%s"', (alias, expected) => {
    expect(resolveModel(alias)).toBe(expected);
  });

  it('passes through unknown model names unchanged', () => {
    expect(resolveModel('llama3.2')).toBe('llama3.2');
    expect(resolveModel('qwen3-coder:30b')).toBe('qwen3-coder:30b');
    expect(resolveModel('some-custom-model')).toBe('some-custom-model');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall
// ---------------------------------------------------------------------------

describe('handleToolCall', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  describe('ollama_list_models', () => {
    it('calls /api/tags and returns formatted model list', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3.2', size: 2_000_000_000 },
            { name: 'x/flux2-klein:9b', size: 6_000_000_000 },
          ],
        }),
      });

      const result = await handleToolCall('ollama_list_models', {}, chatJid, groupFolder);

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/tags'));
      expect(result).toContain('llama3.2');
      expect(result).toContain('x/flux2-klein:9b');
      expect(result).toContain('2.0GB');
      expect(result).toContain('6.0GB');
    });
  });

  // Helpers for mocking the full image generation chain:
  //   1. enhancePrompt → POST /api/chat (llama3.2)
  //   2. comfyuiAvailable → GET /system_stats (returns ok:false → ComfyUI skipped)
  //   3. ollamaDiffuserAvailable → GET /api/models (returns ok:false → OD skipped)
  //   4. generateImageOllama → POST /api/generate (success)
  function mockEnhancePrompt(enhanced = 'enhanced prompt') {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: enhanced } }),
    });
  }
  function mockComfyUIUnavailable() {
    mockFetch.mockResolvedValueOnce({ ok: false });
  }
  function mockOllamaDiffuserUnavailable() {
    mockFetch.mockResolvedValueOnce({ ok: false });
  }

  describe('ollama_generate — image model', () => {
    it('calls /api/generate, writes IPC file, returns success message', async () => {
      const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
      mockEnhancePrompt();
      mockComfyUIUnavailable();
      mockOllamaDiffuserUnavailable();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: [fakeBase64] }),
      });

      const result = await handleToolCall(
        'ollama_generate',
        { model: 'x/flux2-klein:9b', prompt: 'a sunset over the ocean' },
        chatJid,
        groupFolder,
      );

      const generateCall = mockFetch.mock.calls.find(
        ([url]: [unknown, ...unknown[]]) => typeof url === 'string' && url.includes('/api/generate'),
      );
      expect(generateCall).toBeDefined();
      expect(generateCall![1]).toMatchObject({ method: 'POST' });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();

      // IPC file should contain the image and correct type
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const ipcData = JSON.parse(writeCall[1] as string);
      expect(ipcData.type).toBe('image');
      expect(ipcData.chatJid).toBe(chatJid);
      expect(ipcData.imageBase64).toBe(fakeBase64);

      expect(result).toContain('✅');
    });

    it('resolves flux alias before calling API', async () => {
      mockEnhancePrompt();
      mockComfyUIUnavailable();
      mockOllamaDiffuserUnavailable();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: ['abc123'] }),
      });

      await handleToolCall(
        'ollama_generate',
        { model: 'flux', prompt: 'a cat' },
        chatJid,
        groupFolder,
      );

      const generateCall = mockFetch.mock.calls.find(
        ([url]: [unknown, ...unknown[]]) => typeof url === 'string' && url.includes('/api/generate'),
      );
      expect(generateCall).toBeDefined();
      const body = JSON.parse((generateCall![1] as { body: string }).body);
      expect(body.model).toBe('x/flux2-klein:9b');
    });

    it('uses response field if images array is absent', async () => {
      const fakeBase64 = 'abc123def456';
      mockEnhancePrompt();
      mockComfyUIUnavailable();
      mockOllamaDiffuserUnavailable();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: fakeBase64 }),
      });

      await handleToolCall(
        'ollama_generate',
        { model: 'x/flux2-klein:9b', prompt: 'a mountain' },
        chatJid,
        groupFolder,
      );

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const ipcData = JSON.parse(writeCall[1] as string);
      expect(ipcData.imageBase64).toBe(fakeBase64);
    });

    it('throws if API returns non-ok status', async () => {
      mockEnhancePrompt();
      mockComfyUIUnavailable();
      mockOllamaDiffuserUnavailable();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });

      await expect(
        handleToolCall(
          'ollama_generate',
          { model: 'x/flux2-klein:9b', prompt: 'test' },
          chatJid,
          groupFolder,
        ),
      ).rejects.toThrow('404');
    });

    it('throws if response contains no image data', async () => {
      mockEnhancePrompt();
      mockComfyUIUnavailable();
      mockOllamaDiffuserUnavailable();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: [], response: '' }),
      });

      await expect(
        handleToolCall(
          'ollama_generate',
          { model: 'flux', prompt: 'test' },
          chatJid,
          groupFolder,
        ),
      ).rejects.toThrow('No image');
    });
  });

  describe('ollama_generate — text model', () => {
    it('calls /api/chat and returns text response', async () => {
      mockFetch.mockResolvedValueOnce(ollamaTextResponse('Paris is the capital of France.'));

      const result = await handleToolCall(
        'ollama_generate',
        { model: 'llama3.2', prompt: 'What is the capital of France?' },
        chatJid,
        groupFolder,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/chat'),
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result).toBe('Paris is the capital of France.');
    });

    it('includes system prompt when provided', async () => {
      mockFetch.mockResolvedValueOnce(ollamaTextResponse('response'));

      await handleToolCall(
        'ollama_generate',
        { model: 'llama3.2', prompt: 'hello', system: 'Be brief.' },
        chatJid,
        groupFolder,
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    });
  });

  describe('web_search', () => {
    function mockSearchResponse(results: Array<{ title: string; url: string; content?: string }>) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results }),
      });
    }

    it('returns formatted results for a successful search', async () => {
      mockSearchResponse([
        { title: 'Result One', url: 'https://example.com/1', content: 'Summary of result one.' },
        { title: 'Result Two', url: 'https://example.com/2', content: 'Summary of result two.' },
      ]);

      const result = await handleToolCall('web_search', { query: 'test query' }, chatJid, groupFolder);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [[url]] = mockFetch.mock.calls;
      expect(url).toContain('/search?q=test%20query');
      expect(url).toContain('format=json');
      expect(result).toContain('**1. Result One**');
      expect(result).toContain('https://example.com/1');
      expect(result).toContain('Summary of result one.');
      expect(result).toContain('**2. Result Two**');
      expect(result).toContain('---');
    });

    it('returns error string for empty query', async () => {
      const result = await handleToolCall('web_search', { query: '' }, chatJid, groupFolder);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toBe('Error: no query provided');
    });

    it('returns error string when query is missing', async () => {
      const result = await handleToolCall('web_search', {}, chatJid, groupFolder);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toBe('Error: no query provided');
    });

    it('returns "No results found." when results array is empty', async () => {
      mockSearchResponse([]);

      const result = await handleToolCall('web_search', { query: 'obscure query' }, chatJid, groupFolder);

      expect(result).toBe('No results found.');
    });

    it('returns "No results found." when results field is absent', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const result = await handleToolCall('web_search', { query: 'test' }, chatJid, groupFolder);

      expect(result).toBe('No results found.');
    });

    it('throws on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      await expect(
        handleToolCall('web_search', { query: 'test' }, chatJid, groupFolder),
      ).rejects.toThrow('503');
    });

    it('caps results at max_results (default 5)', async () => {
      mockSearchResponse(
        Array.from({ length: 8 }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://example.com/${i + 1}` })),
      );

      const result = await handleToolCall('web_search', { query: 'test' }, chatJid, groupFolder);

      expect(result).toContain('**5.');
      expect(result).not.toContain('**6.');
    });

    it('respects max_results parameter', async () => {
      mockSearchResponse(
        Array.from({ length: 8 }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://example.com/${i + 1}` })),
      );

      const result = await handleToolCall('web_search', { query: 'test', max_results: 3 }, chatJid, groupFolder);

      expect(result).toContain('**3.');
      expect(result).not.toContain('**4.');
    });

    it('caps max_results at 10 even if higher value is passed', async () => {
      mockSearchResponse(
        Array.from({ length: 15 }, (_, i) => ({ title: `R${i + 1}`, url: `https://example.com/${i + 1}` })),
      );

      const result = await handleToolCall('web_search', { query: 'test', max_results: 50 }, chatJid, groupFolder);

      expect(result).toContain('**10.');
      expect(result).not.toContain('**11.');
    });

    it('handles missing content field gracefully', async () => {
      mockSearchResponse([{ title: 'No Snippet', url: 'https://example.com' }]);

      const result = await handleToolCall('web_search', { query: 'test' }, chatJid, groupFolder);

      expect(result).toContain('**1. No Snippet**');
      expect(result).toContain('https://example.com');
    });

    it('uses SEARXNG_HOST env var when set', async () => {
      process.env.SEARXNG_HOST = 'http://custom-host:9999';
      mockSearchResponse([{ title: 'Custom', url: 'https://x.com' }]);

      await handleToolCall('web_search', { query: 'test' }, chatJid, groupFolder);

      const [[url]] = mockFetch.mock.calls;
      expect(url).toContain('http://custom-host:9999');
      delete process.env.SEARXNG_HOST;
    });
  });

  describe('unknown tool', () => {
    it('returns unknown tool message', async () => {
      const result = await handleToolCall('nonexistent_tool', {}, chatJid, groupFolder);
      expect(result).toContain('Unknown tool');
    });
  });
});

// ---------------------------------------------------------------------------
// callOllama
// ---------------------------------------------------------------------------

describe('callOllama', () => {
  const model = 'llama3.2';
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';
  const messages = [
    { role: 'system' as const, content: 'You are Jarvis.' },
    { role: 'user' as const, content: 'Hello' },
  ];

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns text response with no images', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('Hi there!'));

    const result = await callOllama(model, messages, chatJid, groupFolder);

    expect(result).toBe('Hi there!');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[body.messages.length - 1].images).toBeUndefined();
  });

  it('attaches images to the last user message', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('I see a cat.'));

    const images = ['base64imagedata1', 'base64imagedata2'];
    await callOllama(model, messages, chatJid, groupFolder, images);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.images).toEqual(images);
  });

  it('does not modify non-last messages when attaching images', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('ok'));

    await callOllama(model, messages, chatJid, groupFolder, ['img']);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].images).toBeUndefined(); // system msg untouched
  });

  it('passes OLLAMA_TOOLS in the request', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('ok'));

    await callOllama(model, messages, chatJid, groupFolder);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it('executes tool-call loop and returns final text', async () => {
    // Round 1: model calls ollama_list_models
    mockFetch
      .mockResolvedValueOnce(ollamaToolCallResponse('ollama_list_models', {}))
      // tool execution: /api/tags
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.2', size: 2e9 }] }),
      })
      // Round 2: model returns text after seeing tool result
      .mockResolvedValueOnce(ollamaTextResponse('You have llama3.2 installed.'));

    const result = await callOllama(model, messages, chatJid, groupFolder);
    expect(result).toBe('You have llama3.2 installed.');
    // fetch called 3 times: initial + tool + follow-up
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('stops tool-call loop after 5 rounds', async () => {
    // Always returns a tool call — loop should stop at 5
    const infiniteToolCall = ollamaToolCallResponse('ollama_list_models', {});
    const tagsMock = {
      ok: true,
      json: async () => ({ models: [] }),
    };
    // 6 pairs (tool call + tag fetch) but loop caps at 5; final response is empty text
    mockFetch
      .mockResolvedValue(infiniteToolCall) // default for tool calls
      .mockResolvedValueOnce(infiniteToolCall) // round 1 initial
      .mockResolvedValueOnce(tagsMock)         // round 1 tool
      .mockResolvedValueOnce(infiniteToolCall) // round 2
      .mockResolvedValueOnce(tagsMock)
      .mockResolvedValueOnce(infiniteToolCall) // round 3
      .mockResolvedValueOnce(tagsMock)
      .mockResolvedValueOnce(infiniteToolCall) // round 4
      .mockResolvedValueOnce(tagsMock)
      .mockResolvedValueOnce(infiniteToolCall) // round 5
      .mockResolvedValueOnce(tagsMock)
      .mockResolvedValueOnce(ollamaTextResponse('Done.')); // round 6 — not reached

    // Should not throw and should stop
    const result = await callOllama(model, messages, chatJid, groupFolder);
    // After 5 rounds the loop exits and returns whatever content is in msg
    expect(typeof result).toBe('string');
  });

  it('throws on non-ok API response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(callOllama(model, messages, chatJid, groupFolder)).rejects.toThrow(
      'Ollama API error: 500',
    );
  });
});

// ---------------------------------------------------------------------------
// classifyMessage — DISABLE_SECRETARY=1 keyword classification path
// ---------------------------------------------------------------------------

describe('classifyMessage (DISABLE_SECRETARY=1)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.DISABLE_SECRETARY = '1';
  });

  afterEach(() => {
    delete process.env.DISABLE_SECRETARY;
  });

  describe('code detection', () => {
    it('detects backtick code spans', async () => {
      const cls = await classifyMessage('What does `Array.map()` do?', false);
      expect(cls.taskType).toBe('code');
      expect(cls.model).toBe(MODELS.CODER);
    });

    it('detects code blocks', async () => {
      const cls = await classifyMessage('```\nconst x = 1;\n```', false);
      expect(cls.taskType).toBe('code');
    });

    it('detects "implement" keyword', async () => {
      const cls = await classifyMessage('implement a binary search algorithm', false);
      expect(cls.taskType).toBe('code');
      expect(cls.model).toBe(MODELS.CODER);
    });

    it('detects "refactor" keyword', async () => {
      const cls = await classifyMessage('refactor the database module', false);
      expect(cls.taskType).toBe('code');
    });

    it('detects .ts file references', async () => {
      const cls = await classifyMessage('check out index.ts for bugs', false);
      expect(cls.taskType).toBe('code');
    });

    it('detects .py file references', async () => {
      const cls = await classifyMessage('look at main.py and fix the import', false);
      expect(cls.taskType).toBe('code');
    });

    it('detects "write a function" pattern', async () => {
      const cls = await classifyMessage('write a function that sorts an array', false);
      expect(cls.taskType).toBe('code');
    });
  });

  describe('creative detection', () => {
    it('detects "write a story"', async () => {
      const cls = await classifyMessage('write a story about a robot', false);
      expect(cls.taskType).toBe('creative');
      expect(cls.taskTypeRich).toBe('creative');
    });

    it('detects "compose a poem"', async () => {
      const cls = await classifyMessage('compose a poem about autumn', false);
      expect(cls.taskType).toBe('creative');
    });

    it('detects "create a song"', async () => {
      const cls = await classifyMessage('create a song about love', false);
      expect(cls.taskType).toBe('creative');
    });
  });

  describe('think detection', () => {
    it('"compare" alone does not trigger think (too broad — secretary handles it)', async () => {
      const cls = await classifyMessage('compare React and Vue', false);
      // With DISABLE_SECRETARY=1, regex no longer has "compare" as standalone trigger
      expect(cls.think).toBe(false);
    });

    it('detects "pros and cons"', async () => {
      const cls = await classifyMessage('what are the pros and cons of remote work?', false);
      expect(cls.think).toBe(true);
    });

    it('detects "should I"', async () => {
      const cls = await classifyMessage('should I switch to TypeScript?', false);
      expect(cls.think).toBe(true);
    });

    it('does not think for simple greetings', async () => {
      const cls = await classifyMessage('hello', false);
      expect(cls.think).toBe(false);
    });
  });

  describe('needs web detection', () => {
    it('detects "today"', async () => {
      const cls = await classifyMessage("what's the weather today?", false);
      expect(cls.needsWeb).toBe(true);
    });

    it('detects "current price"', async () => {
      const cls = await classifyMessage('current price of Bitcoin', false);
      expect(cls.needsWeb).toBe(true);
    });

    it('detects "latest news"', async () => {
      const cls = await classifyMessage('latest news about AI', false);
      expect(cls.needsWeb).toBe(true);
    });

    it('detects "weather"', async () => {
      const cls = await classifyMessage('weather in London', false);
      expect(cls.needsWeb).toBe(true);
    });

    it('does not need web for static questions', async () => {
      const cls = await classifyMessage('what is the speed of light?', false);
      expect(cls.needsWeb).toBe(false);
    });
  });

  describe('complexity estimation', () => {
    it('short message = low complexity', async () => {
      const cls = await classifyMessage('hello there', false);
      expect(cls.complexity).toBe('low');
    });

    it('long message = high complexity', async () => {
      const longMsg = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
      const cls = await classifyMessage(longMsg, false);
      expect(cls.complexity).toBe('high');
    });

    it('multiple questions = high complexity', async () => {
      const cls = await classifyMessage('What is X? And what about Y? How does Z work?', false);
      expect(cls.complexity).toBe('high');
    });

    it('medium length message = medium complexity', async () => {
      const cls = await classifyMessage('Can you explain how neural networks work in machine learning systems?', false);
      expect(cls.complexity).toBe('medium');
    });
  });

  describe('image routing', () => {
    it('routes to vision model when hasImages is true', async () => {
      const cls = await classifyMessage('what is in this picture?', true);
      expect(cls.model).toBe(MODELS.VISION);
      expect(cls.usedSecretary).toBe(false);
    });

    it('routes to vision model regardless of text content', async () => {
      const cls = await classifyMessage('implement a function', true);
      expect(cls.model).toBe(MODELS.VISION);
    });
  });

  describe('general classification fields', () => {
    it('sets usedSecretary to false', async () => {
      const cls = await classifyMessage('hello world', false);
      expect(cls.usedSecretary).toBe(false);
    });

    it('sets temperature based on task type', async () => {
      const codeCls = await classifyMessage('implement a sort', false);
      expect(codeCls.temperature).toBe(0.2);

      const creativeCls = await classifyMessage('write a story about dragons', false);
      expect(creativeCls.temperature).toBe(0.9);
    });

    it('does not call fetch (no LLM secretary call)', async () => {
      await classifyMessage('hello world', false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// buildRouteHint
// ---------------------------------------------------------------------------

describe('buildRouteHint', () => {
  it('returns string in [Route: ...] format', () => {
    const hint = buildRouteHint('hello', false);
    expect(hint).toMatch(/^\[Route: .+\]$/);
  });

  it('includes "code task" for coding messages', () => {
    const hint = buildRouteHint('implement a binary search', false);
    expect(hint).toContain('code task');
  });

  it('includes "creative task" for creative messages', () => {
    const hint = buildRouteHint('write a story about space', false);
    expect(hint).toContain('creative task');
  });

  it('includes complexity level', () => {
    const hint = buildRouteHint('hi', false);
    expect(hint).toContain('low');
  });

  it('includes "needs live data" for web queries', () => {
    const hint = buildRouteHint("what's the weather today?", false);
    expect(hint).toContain('needs live data');
  });

  it('includes "complex reasoning" for think-triggering messages', () => {
    const hint = buildRouteHint('compare React and Vue pros and cons', false);
    expect(hint).toContain('complex reasoning');
  });

  it('includes "images attached" when hasImages is true', () => {
    const hint = buildRouteHint('describe this', true);
    expect(hint).toContain('images attached');
    expect(hint).toContain('vision task');
  });

  it('does not include "images attached" when hasImages is false', () => {
    const hint = buildRouteHint('describe this', false);
    expect(hint).not.toContain('images attached');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — preferences
// ---------------------------------------------------------------------------

describe('handleToolCall — preferences', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  // Track what preferences are stored via fs mock
  let prefStore: string;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.existsSync).mockReset();

    prefStore = JSON.stringify({ group: {}, users: {} });

    // Make existsSync return true for preferences file, false otherwise
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (String(p).includes('.preferences.json')) return true;
      return false;
    });

    // readFileSync returns current prefStore for preferences file
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).includes('.preferences.json')) return prefStore;
      return '[]';
    });

    // writeFileSync captures what's written to preferences
    vi.mocked(fs.writeFileSync).mockImplementation((p, data) => {
      if (String(p).includes('.preferences.json')) {
        prefStore = String(data);
      }
    });
  });

  it('action: list when empty returns "No preferences set."', async () => {
    prefStore = JSON.stringify({ group: {}, users: {} });
    const result = await handleToolCall('preferences', { action: 'list' }, chatJid, groupFolder);
    expect(result).toBe('No preferences set.');
  });

  it('action: set group scope returns success message', async () => {
    const result = await handleToolCall(
      'preferences',
      { action: 'set', key: 'verbose', value: true },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Set verbose');
    expect(result).toContain('true');
    expect(result).toContain('this group');
  });

  it('action: get after set returns value', async () => {
    // Set first
    await handleToolCall(
      'preferences',
      { action: 'set', key: 'response_language', value: 'es' },
      chatJid,
      groupFolder,
    );

    // Get
    const result = await handleToolCall(
      'preferences',
      { action: 'get', key: 'response_language' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('response_language');
    expect(result).toContain('es');
  });

  it('action: set user scope with user_id returns success', async () => {
    const result = await handleToolCall(
      'preferences',
      { action: 'set', key: 'verbose', value: false, scope: 'user', user_id: 'user123' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Set verbose');
    expect(result).toContain('user123');
  });

  it('action: get with user_id returns user override over group default', async () => {
    // Set group default
    await handleToolCall(
      'preferences',
      { action: 'set', key: 'theme', value: 'light' },
      chatJid,
      groupFolder,
    );

    // Set user override
    await handleToolCall(
      'preferences',
      { action: 'set', key: 'theme', value: 'dark', scope: 'user', user_id: 'user456' },
      chatJid,
      groupFolder,
    );

    // Get with user_id should return user override
    const result = await handleToolCall(
      'preferences',
      { action: 'get', key: 'theme', user_id: 'user456' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('dark');
  });

  it('action: set with null value deletes the preference', async () => {
    // Set a preference first
    await handleToolCall(
      'preferences',
      { action: 'set', key: 'verbose', value: true },
      chatJid,
      groupFolder,
    );

    // Delete it by setting null
    await handleToolCall(
      'preferences',
      { action: 'set', key: 'verbose', value: null },
      chatJid,
      groupFolder,
    );

    // Get should show not set
    const result = await handleToolCall(
      'preferences',
      { action: 'get', key: 'verbose' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('not set');
  });

  it('missing key on get returns error', async () => {
    const result = await handleToolCall(
      'preferences',
      { action: 'get', key: '' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Error');
    expect(result).toContain('key');
  });

  it('missing key on set returns error', async () => {
    const result = await handleToolCall(
      'preferences',
      { action: 'set', key: '', value: 'test' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Error');
    expect(result).toContain('key');
  });

  it('user scope without user_id returns error', async () => {
    const result = await handleToolCall(
      'preferences',
      { action: 'set', key: 'theme', value: 'dark', scope: 'user' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Error');
    expect(result).toContain('user_id');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — service_status
// ---------------------------------------------------------------------------

describe('handleToolCall — service_status', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('all services up shows all green', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const result = await handleToolCall('service_status', {}, chatJid, groupFolder);

    expect(result).toContain('Ollama');
    expect(result).toContain('ComfyUI');
    expect(result).toContain('OllamaDiffuser');
    expect(result).toContain('SearXNG');
    // All should be online
    const lines = result.split('\n');
    for (const line of lines) {
      expect(line).toContain('online');
    }
  });

  it('some services down shows red for those', async () => {
    // Ollama up, ComfyUI down, OllamaDiffuser up, SearXNG down
    mockFetch
      .mockResolvedValueOnce({ ok: true })   // Ollama
      .mockResolvedValueOnce({ ok: false })  // ComfyUI
      .mockResolvedValueOnce({ ok: true })   // OllamaDiffuser
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // SearXNG

    const result = await handleToolCall('service_status', {}, chatJid, groupFolder);

    expect(result).toContain('Ollama');
    expect(result).toContain('online');
    expect(result).toContain('offline');
  });

  it('fetch rejection (network error) shows offline', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await handleToolCall('service_status', {}, chatJid, groupFolder);

    const lines = result.split('\n');
    for (const line of lines) {
      expect(line).toContain('offline');
    }
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — manage_service
// ---------------------------------------------------------------------------

describe('handleToolCall — manage_service', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  it('valid service returns success message', async () => {
    const result = await handleToolCall(
      'manage_service',
      { service: 'ollama', action: 'start' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Start');
    expect(result).toContain('ollama');
    expect(result).toContain('requested');
  });

  it('restart action returns restart message', async () => {
    const result = await handleToolCall(
      'manage_service',
      { service: 'comfyui', action: 'restart' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Restart');
    expect(result).toContain('comfyui');
  });

  it('missing service returns error', async () => {
    const result = await handleToolCall(
      'manage_service',
      { service: '' },
      chatJid,
      groupFolder,
    );
    expect(result).toContain('Error');
    expect(result).toContain('no service');
  });

  it('writes IPC file with correct structure', async () => {
    await handleToolCall(
      'manage_service',
      { service: 'searxng', action: 'restart' },
      chatJid,
      groupFolder,
    );

    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const ipcPath = String(writeCall[0]);
    expect(ipcPath).toContain('svc-');
    expect(ipcPath).toContain('.json');

    const ipcData = JSON.parse(String(writeCall[1]));
    expect(ipcData.type).toBe('manage_service');
    expect(ipcData.service).toBe('searxng');
    expect(ipcData.action).toBe('restart');
  });

  it('defaults action to start when not provided', async () => {
    await handleToolCall(
      'manage_service',
      { service: 'ollama' },
      chatJid,
      groupFolder,
    );

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const ipcData = JSON.parse(String(writeCall[1]));
    expect(ipcData.action).toBe('start');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — ollama_pull
// ---------------------------------------------------------------------------

describe('handleToolCall — ollama_pull', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('successful pull returns success message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success' }),
    });

    const result = await handleToolCall(
      'ollama_pull',
      { name: 'llama3.2:13b' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('Pulled llama3.2:13b');
    expect(result).toContain('success');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/pull'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('empty name returns error', async () => {
    const result = await handleToolCall(
      'ollama_pull',
      { name: '' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('Error');
    expect(result).toContain('no model name');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('missing name returns error', async () => {
    const result = await handleToolCall(
      'ollama_pull',
      {},
      chatJid,
      groupFolder,
    );

    expect(result).toContain('Error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('API error throws', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'model not found',
    });

    await expect(
      handleToolCall('ollama_pull', { name: 'nonexistent:latest' }, chatJid, groupFolder),
    ).rejects.toThrow('Pull failed');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — ollama_remove
// ---------------------------------------------------------------------------

describe('handleToolCall — ollama_remove', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('successful remove returns success message', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await handleToolCall(
      'ollama_remove',
      { name: 'llama3.2:13b' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('Removed llama3.2:13b');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/delete'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('empty name returns error', async () => {
    const result = await handleToolCall(
      'ollama_remove',
      { name: '' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('Error');
    expect(result).toContain('no model name');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('API error throws', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });

    await expect(
      handleToolCall('ollama_remove', { name: 'broken-model:latest' }, chatJid, groupFolder),
    ).rejects.toThrow('Remove failed');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — generate_art
// ---------------------------------------------------------------------------

describe('handleToolCall — generate_art', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns artist interpretation (not a generated image)', async () => {
    const artistJson = JSON.stringify({
      prompt: 'A golden sunset over rolling hills with warm amber tones',
      backend: 'comfyui',
      use_reference: false,
      note: 'Interpreted your request as a landscape scene.',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: artistJson },
        done: true,
      }),
    });

    const result = await handleToolCall(
      'generate_art',
      { request: 'paint a sunset' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain("Artist's interpretation");
    expect(result).toContain('golden sunset');
    expect(result).toContain('Backend: comfyui');
    expect(result).toContain('Reference: no');
    expect(result).toContain('Artist note');
  });

  it('includes prompt, backend, use_reference in response', async () => {
    const artistJson = JSON.stringify({
      prompt: 'A cyberpunk cityscape at night',
      backend: 'ollamadiffuser',
      use_reference: true,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: artistJson },
        done: true,
      }),
    });

    const result = await handleToolCall(
      'generate_art',
      { request: 'cyberpunk city' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('cyberpunk cityscape');
    expect(result).toContain('Backend: ollamadiffuser');
    expect(result).toContain('Reference: yes');
    expect(result).toContain('ollama_generate');
  });

  it('empty request returns error', async () => {
    const result = await handleToolCall(
      'generate_art',
      { request: '' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('Error');
    expect(result).toContain('no request');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles artist returning non-JSON gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: 'A beautiful mountain landscape at dawn with purple sky' },
        done: true,
      }),
    });

    const result = await handleToolCall(
      'generate_art',
      { request: 'mountain at dawn' },
      chatJid,
      groupFolder,
    );

    // Should still return a valid interpretation using the raw text as prompt
    expect(result).toContain("Artist's interpretation");
    expect(result).toContain('mountain landscape');
  });

  it('throws on artist API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    await expect(
      handleToolCall('generate_art', { request: 'a cat' }, chatJid, groupFolder),
    ).rejects.toThrow('Artist error');
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — generate_film
// ---------------------------------------------------------------------------

describe('handleToolCall — generate_film', () => {
  const chatJid = 'tg-j:12345';
  const groupFolder = 'telegram_ollama';

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns cinematographer interpretation (not a generated video)', async () => {
    const cinemaJson = JSON.stringify({
      prompt: 'Slow tracking shot through a misty forest at dawn, golden light filtering through trees',
      backend: 'comfyui',
      use_reference: false,
      note: 'Added cinematic camera movement and atmosphere.',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: cinemaJson },
        done: true,
      }),
    });

    const result = await handleToolCall(
      'generate_film',
      { request: 'walking through a forest' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain("Cinematographer's interpretation");
    expect(result).toContain('tracking shot');
    expect(result).toContain('Backend: comfyui');
    expect(result).toContain('Reference: no');
    expect(result).toContain('Cinematographer note');
  });

  it('includes prompt, backend, use_reference in response', async () => {
    const cinemaJson = JSON.stringify({
      prompt: 'Close-up of ocean waves crashing on rocks',
      backend: 'auto',
      use_reference: true,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: cinemaJson },
        done: true,
      }),
    });

    const result = await handleToolCall(
      'generate_film',
      { request: 'ocean waves' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('ocean waves');
    expect(result).toContain('Backend: auto');
    expect(result).toContain('Reference: yes');
    expect(result).toContain('generate_video');
  });

  it('empty request returns error', async () => {
    const result = await handleToolCall(
      'generate_film',
      { request: '' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain('Error');
    expect(result).toContain('no request');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles cinematographer returning non-JSON gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: 'A drone shot rising above clouds at golden hour' },
        done: true,
      }),
    });

    const result = await handleToolCall(
      'generate_film',
      { request: 'sky view' },
      chatJid,
      groupFolder,
    );

    expect(result).toContain("Cinematographer's interpretation");
    expect(result).toContain('drone shot');
  });

  it('throws on cinematographer API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(
      handleToolCall('generate_film', { request: 'a sunset' }, chatJid, groupFolder),
    ).rejects.toThrow('Cinematographer error');
  });
});

// ---------------------------------------------------------------------------
// callOllama — auto-escalation context preservation (PM-012)
// ---------------------------------------------------------------------------

describe('callOllama — context coherence across escalation (PM-012)', () => {
  const chatJid = 'tg-j:99999';
  const groupFolder = 'telegram_test';

  // Multi-turn conversation: system + two user/assistant exchanges + new user message
  const multiTurnMessages = [
    { role: 'system' as const, content: 'You are Jarvis, a helpful assistant.' },
    { role: 'user' as const, content: 'What is quantum computing?' },
    { role: 'assistant' as const, content: 'Quantum computing uses qubits...' },
    { role: 'user' as const, content: 'How does entanglement work?' },
    { role: 'assistant' as const, content: 'Entanglement is a phenomenon where...' },
    { role: 'user' as const, content: 'Explain Shor\'s algorithm step by step' },
  ];

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('auto-escalation passes FULL message history (not just last message) to the escalated model', async () => {
    // Determine the escalation chain: COORDINATOR (no think) → COORDINATOR (think)
    const nextTier = getEscalationTier(MODELS.COORDINATOR, false);
    expect(nextTier).not.toBeNull();

    // First call: coordinator returns a failure phrase that triggers AUTO_ESCALATE_PATTERN
    mockFetch.mockResolvedValueOnce(ollamaTextResponse("I'm unable to solve this problem with my current capabilities."));

    // Second call (escalated): the next tier returns a real answer
    mockFetch.mockResolvedValueOnce(ollamaTextResponse("Shor's algorithm works in these steps: 1) Choose a random number..."));

    const result = await callOllama(MODELS.COORDINATOR, multiTurnMessages, chatJid, groupFolder);

    // The escalated model should have produced the final answer
    expect(result).toContain("Shor's algorithm");

    // Verify two fetch calls were made (original + escalated)
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Parse the body of the SECOND call (the escalated one)
    const escalatedBody = JSON.parse(mockFetch.mock.calls[1][1].body);

    // The escalated call must include ALL original messages, not just the last user message
    expect(escalatedBody.messages.length).toBe(multiTurnMessages.length);

    // Verify the system message is preserved
    expect(escalatedBody.messages[0]).toMatchObject({
      role: 'system',
      content: 'You are Jarvis, a helpful assistant.',
    });

    // Verify prior conversation history is preserved
    expect(escalatedBody.messages[1]).toMatchObject({
      role: 'user',
      content: 'What is quantum computing?',
    });
    expect(escalatedBody.messages[2]).toMatchObject({
      role: 'assistant',
      content: 'Quantum computing uses qubits...',
    });
    expect(escalatedBody.messages[3]).toMatchObject({
      role: 'user',
      content: 'How does entanglement work?',
    });
    expect(escalatedBody.messages[4]).toMatchObject({
      role: 'assistant',
      content: 'Entanglement is a phenomenon where...',
    });

    // Verify the final user message is present
    expect(escalatedBody.messages[5]).toMatchObject({
      role: 'user',
      content: expect.stringContaining("Shor's algorithm"),
    });
  });

  it('auto-escalation uses the correct next-tier model', async () => {
    const nextTier = getEscalationTier(MODELS.COORDINATOR, false)!;

    // First call: failure phrase triggers auto-escalation
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('I apologize, I cannot determine the answer.'));

    // Second call: escalated model responds
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('Here is the answer.'));

    await callOllama(MODELS.COORDINATOR, multiTurnMessages, chatJid, groupFolder);

    // The escalated call should target the next tier model
    const escalatedBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(escalatedBody.model).toBe(nextTier.model);
  });

  it('no escalation when response does not contain failure phrases', async () => {
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('Quantum entanglement allows particles to be correlated.'));

    const result = await callOllama(MODELS.COORDINATOR, multiTurnMessages, chatJid, groupFolder);

    expect(result).toContain('Quantum entanglement');
    // Only one fetch call — no escalation
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('explicit escalate tool call also passes full history', async () => {
    // Model uses the escalate tool instead of auto-escalation
    const nextTier = getEscalationTier(MODELS.COORDINATOR, false)!;

    // First call: model calls the escalate tool
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'escalate', arguments: { reason: 'needs deeper analysis' } } }],
        },
        done: true,
      }),
    });

    // Second call: escalated model responds
    mockFetch.mockResolvedValueOnce(ollamaTextResponse('Deep analysis complete.'));

    const result = await callOllama(MODELS.COORDINATOR, multiTurnMessages, chatJid, groupFolder);

    expect(result).toContain('Deep analysis complete');

    // The escalated call (second fetch) should have the full history
    const escalatedBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(escalatedBody.messages.length).toBe(multiTurnMessages.length);
    expect(escalatedBody.messages[0].role).toBe('system');
    expect(escalatedBody.messages[0].content).toContain('Jarvis');
    expect(escalatedBody.model).toBe(nextTier.model);
  });
});
