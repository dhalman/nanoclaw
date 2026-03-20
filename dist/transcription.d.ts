/**
 * Local voice transcription using faster-whisper via scripts/transcribe.py.
 * No API key required — runs entirely on device.
 *
 * Model is downloaded from HuggingFace on first use:
 *   - base  (~244MB, good accuracy, ~5-10s on Apple Silicon) — default
 *   - tiny  (~74MB, faster, slightly less accurate)
 *   - small (~488MB, better accuracy, slower)
 *
 * Set WHISPER_MODEL=tiny|base|small in .env to change the model.
 */
export interface TranscriptionResult {
    text: string;
    language: string;
    languageProbability: number;
}
/**
 * Transcribe an audio buffer (OGG/Opus from Telegram voice messages).
 * Returns transcript text, detected language, and confidence — or null on failure.
 */
export declare function transcribeAudio(audioBuffer: Buffer, ext?: string): Promise<TranscriptionResult | null>;
//# sourceMappingURL=transcription.d.ts.map