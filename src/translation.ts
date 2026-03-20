/**
 * Translate text using a local Ollama model.
 * Uses the secretary model (qwen2.5:3b) for fast parallel translation.
 */

import { logger } from './logger.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'qwen3.5:35b';
const TRANSLATE_TIMEOUT_MS = 15_000;

// ISO 639-1 → display name
const LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans',
  ar: 'Arabic',
  bg: 'Bulgarian',
  bn: 'Bengali',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  et: 'Estonian',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  gu: 'Gujarati',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  lt: 'Lithuanian',
  lv: 'Latvian',
  mk: 'Macedonian',
  ml: 'Malayalam',
  mr: 'Marathi',
  ms: 'Malay',
  nl: 'Dutch',
  no: 'Norwegian',
  pa: 'Punjabi',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sq: 'Albanian',
  sr: 'Serbian',
  sv: 'Swedish',
  sw: 'Swahili',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tl: 'Tagalog',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

// Reverse lookup: name → code
const LANGUAGE_CODES: Record<string, string> = {};
for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
  LANGUAGE_CODES[name.toLowerCase()] = code;
}

export function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}

export function getLanguageCode(nameOrCode: string): string | null {
  const lower = nameOrCode.toLowerCase().trim();
  if (LANGUAGE_NAMES[lower]) return lower; // already a code
  return LANGUAGE_CODES[lower] || null;
}

/**
 * Translate text from one language to another using a local Ollama model.
 * Returns the translated text or null on failure.
 */
export async function translateText(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string | null> {
  if (sourceLanguage === targetLanguage) return null;

  const isAuto = sourceLanguage === 'auto';
  const sourceName = isAuto
    ? 'the source language'
    : getLanguageName(sourceLanguage);
  const targetName = getLanguageName(targetLanguage);

  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        messages: [
          {
            role: 'system',
            content: `Translate the following ${sourceName} text to ${targetName}. VERBATIM word-for-word translation — do not paraphrase, summarize, or rephrase. Return ONLY the translated text, nothing else. No explanations, no notes, no quotes, no preamble.`,
          },
          { role: 'user', content: text },
        ],
        keep_alive: -1,
        options: { temperature: 0.1, num_ctx: 1024 },
        stream: false,
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      message: { content: string | Array<{ text?: string }> };
    };
    const content = data.message.content;
    const translation =
      typeof content === 'string'
        ? content.trim()
        : Array.isArray(content)
          ? content
              .map((b) => (typeof b === 'string' ? b : (b.text ?? '')))
              .join('')
              .trim()
          : null;

    if (!translation) return null;

    logger.info(
      { from: sourceLanguage, to: targetLanguage, chars: translation.length },
      'Text translated',
    );
    return translation;
  } catch (err) {
    logger.warn({ err, sourceLanguage, targetLanguage }, 'Translation failed');
    return null;
  }
}

/** Convenience wrapper for backward compat */
export async function translateToEnglish(
  text: string,
  sourceLanguage: string,
): Promise<string | null> {
  return translateText(text, sourceLanguage, 'en');
}

export interface TranslationResult {
  targetLanguage: string;
  targetName: string;
  text: string;
}

/**
 * Translate text to multiple target languages in parallel.
 * Skips the source language if it appears in the targets.
 * Returns only successful translations.
 */
export async function translateToMultiple(
  text: string,
  sourceLanguage: string,
  targetLanguages: string[],
): Promise<TranslationResult[]> {
  // Dedupe and skip source language
  const targets = [...new Set(targetLanguages)].filter(
    (t) => t !== sourceLanguage,
  );
  if (targets.length === 0) return [];

  const results = await Promise.allSettled(
    targets.map(async (targetLang) => {
      const translated = await translateText(text, sourceLanguage, targetLang);
      if (!translated) throw new Error(`Translation to ${targetLang} failed`);
      return {
        targetLanguage: targetLang,
        targetName: getLanguageName(targetLang),
        text: translated,
      };
    }),
  );

  return (
    results
      .filter(
        (r): r is PromiseFulfilledResult<TranslationResult> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value)
      // Drop translations identical to source (same-language detection for 'auto' mode)
      .filter((r) => r.text.trim().toLowerCase() !== text.trim().toLowerCase())
  );
}
