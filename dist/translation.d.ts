/**
 * Translate text using a local Ollama model.
 * Uses qwen2.5:3b (secretary) for auto-translations — runs on a separate
 * model from the coordinator so translations don't queue/timeout.
 * On-demand translations (👀 reaction, "translate" reply) use the same
 * model for consistency. Users can ask Jarvis directly for a more
 * accurate translation which will use the coordinator (35B).
 */
export declare function getLanguageName(code: string): string;
export declare function getLanguageCode(nameOrCode: string): string | null;
/**
 * Translate text from one language to another using a local Ollama model.
 * Returns the translated text or null on failure.
 */
export declare function translateText(text: string, sourceLanguage: string, targetLanguage: string, modelOverride?: string): Promise<string | null>;
/** Convenience wrapper for backward compat */
export declare function translateToEnglish(text: string, sourceLanguage: string): Promise<string | null>;
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
export declare function translateToMultiple(text: string, sourceLanguage: string, targetLanguages: string[], modelOverride?: string): Promise<TranslationResult[]>;
//# sourceMappingURL=translation.d.ts.map