import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLanguageCode,
  getLanguageName,
  translateText,
  translateToEnglish,
  translateToMultiple,
} from './translation.js';

// --- getLanguageName ---

describe('getLanguageName', () => {
  it('returns display name for known code', () => {
    expect(getLanguageName('en')).toBe('English');
    expect(getLanguageName('es')).toBe('Español');
    expect(getLanguageName('ja')).toBe('日本語');
  });

  it('returns code itself for unknown code', () => {
    expect(getLanguageName('xx')).toBe('xx');
  });
});

// --- getLanguageCode ---

describe('getLanguageCode', () => {
  it('returns code for known name (case insensitive)', () => {
    expect(getLanguageCode('English')).toBe('en');
    expect(getLanguageCode('ESPAÑOL')).toBe('es');
    expect(getLanguageCode('en')).toBe('en');
  });

  it('returns code when already given a code', () => {
    expect(getLanguageCode('en')).toBe('en');
    expect(getLanguageCode('fr')).toBe('fr');
  });

  it('returns null for unknown language', () => {
    expect(getLanguageCode('Klingon')).toBeNull();
    expect(getLanguageCode('xx')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(getLanguageCode('  English  ')).toBe('en');
  });
});

// --- translateText ---

describe('translateText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when source equals target', async () => {
    const result = await translateText('hello', 'en', 'en');
    expect(result).toBeNull();
  });

  it('returns translated text on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: { content: 'Hola' } }),
      }),
    );

    const result = await translateText('Hello', 'en', 'es');
    expect(result).toBe('Hola');
  });

  it('returns null on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await translateText('Hello', 'en', 'es');
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network error')),
    );

    const result = await translateText('Hello', 'en', 'es');
    expect(result).toBeNull();
  });

  it('returns null when response content is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: { content: '   ' } }),
      }),
    );

    const result = await translateText('Hello', 'en', 'es');
    expect(result).toBeNull();
  });

  it('handles array content format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: [{ text: 'Hola' }, { text: ' mundo' }] },
          }),
      }),
    );

    const result = await translateText('Hello world', 'en', 'es');
    expect(result).toBe('Hola mundo');
  });

  it('uses "the source language" for auto mode', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'Bonjour' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await translateText('Hello', 'auto', 'fr');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('the source language');
  });
});

// --- translateToMultiple ---

describe('translateToMultiple', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when no targets differ from source', async () => {
    const result = await translateToMultiple('Hello', 'en', ['en']);
    expect(result).toEqual([]);
  });

  it('deduplicates target languages', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'Hola' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await translateToMultiple('Hello', 'en', ['es', 'es', 'es']);
    // Should only call fetch once (deduped)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('filters out translations identical to source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: { content: 'Hello' } }),
      }),
    );

    const result = await translateToMultiple('Hello', 'auto', ['es']);
    // Translation is identical to source → filtered out
    expect(result).toEqual([]);
  });

  it('returns successful translations, skips failures', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ message: { content: 'Hola' } }),
          });
        }
        return Promise.resolve({ ok: false }); // fr fails
      }),
    );

    const result = await translateToMultiple('Hello', 'en', ['es', 'fr']);
    expect(result.length).toBe(1);
    expect(result[0].targetLanguage).toBe('es');
    expect(result[0].text).toBe('Hola');
  });
});
