/**
 * Translate text using a local Ollama model.
 * Uses qwen2.5:3b (secretary) for auto-translations — runs on a separate
 * model from the coordinator so translations don't queue/timeout.
 * On-demand translations (👀 reaction, "translate" reply) use the same
 * model for consistency. Users can ask Jarvis directly for a more
 * accurate translation which will use the coordinator (35B).
 */
import { logger } from './logger.js';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'qwen2.5:3b';
const TRANSLATE_TIMEOUT_MS = 15_000;
// ISO 639-1 → native name (shown in translation tags)
const LANGUAGE_NAMES = {
    af: 'Afrikaans',
    ar: 'العربية',
    bg: 'Български',
    bn: 'বাংলা',
    ca: 'Català',
    cs: 'Čeština',
    da: 'Dansk',
    de: 'Deutsch',
    el: 'Ελληνικά',
    en: 'English',
    es: 'Español',
    et: 'Eesti',
    fa: 'فارسی',
    fi: 'Suomi',
    fr: 'Français',
    gu: 'ગુજરાતી',
    he: 'עברית',
    hi: 'हिन्दी',
    hr: 'Hrvatski',
    hu: 'Magyar',
    id: 'Bahasa Indonesia',
    it: 'Italiano',
    ja: '日本語',
    kn: 'ಕನ್ನಡ',
    ko: '한국어',
    lt: 'Lietuvių',
    lv: 'Latviešu',
    mk: 'Македонски',
    ml: 'മലയാളം',
    mr: 'मराठी',
    ms: 'Bahasa Melayu',
    nl: 'Nederlands',
    no: 'Norsk',
    pa: 'ਪੰਜਾਬੀ',
    pl: 'Polski',
    pt: 'Português',
    ro: 'Română',
    ru: 'Русский',
    sk: 'Slovenčina',
    sl: 'Slovenščina',
    sq: 'Shqip',
    sr: 'Српски',
    sv: 'Svenska',
    sw: 'Kiswahili',
    ta: 'தமிழ்',
    te: 'తెలుగు',
    th: 'ไทย',
    tl: 'Tagalog',
    tr: 'Türkçe',
    uk: 'Українська',
    ur: 'اردو',
    vi: 'Tiếng Việt',
    zh: '中文',
};
// Reverse lookup: name → code
const LANGUAGE_CODES = {};
for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
    LANGUAGE_CODES[name.toLowerCase()] = code;
}
export function getLanguageName(code) {
    return LANGUAGE_NAMES[code] || code;
}
export function getLanguageCode(nameOrCode) {
    const lower = nameOrCode.toLowerCase().trim();
    if (LANGUAGE_NAMES[lower])
        return lower; // already a code
    return LANGUAGE_CODES[lower] || null;
}
/**
 * Translate text from one language to another using a local Ollama model.
 * Returns the translated text or null on failure.
 */
export async function translateText(text, sourceLanguage, targetLanguage, modelOverride) {
    if (sourceLanguage === targetLanguage)
        return null;
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
                model: modelOverride || TRANSLATE_MODEL,
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
        if (!resp.ok)
            return null;
        const data = (await resp.json());
        const content = data.message.content;
        const translation = typeof content === 'string'
            ? content.trim()
            : Array.isArray(content)
                ? content
                    .map((b) => (typeof b === 'string' ? b : (b.text ?? '')))
                    .join('')
                    .trim()
                : null;
        if (!translation)
            return null;
        logger.info({ from: sourceLanguage, to: targetLanguage, chars: translation.length }, 'Text translated');
        return translation;
    }
    catch (err) {
        logger.warn({ err, sourceLanguage, targetLanguage }, 'Translation failed');
        return null;
    }
}
/** Convenience wrapper for backward compat */
export async function translateToEnglish(text, sourceLanguage) {
    return translateText(text, sourceLanguage, 'en');
}
/**
 * Translate text to multiple target languages in parallel.
 * Skips the source language if it appears in the targets.
 * Returns only successful translations.
 */
export async function translateToMultiple(text, sourceLanguage, targetLanguages, modelOverride) {
    // Dedupe and skip source language
    const targets = [...new Set(targetLanguages)].filter((t) => t !== sourceLanguage);
    if (targets.length === 0)
        return [];
    const results = await Promise.allSettled(targets.map(async (targetLang) => {
        const translated = await translateText(text, sourceLanguage, targetLang, modelOverride);
        if (!translated)
            throw new Error(`Translation to ${targetLang} failed`);
        return {
            targetLanguage: targetLang,
            targetName: getLanguageName(targetLang),
            text: translated,
        };
    }));
    return (results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value)
        // Drop translations identical to source (same-language detection for 'auto' mode)
        .filter((r) => r.text.trim().toLowerCase() !== text.trim().toLowerCase()));
}
//# sourceMappingURL=translation.js.map