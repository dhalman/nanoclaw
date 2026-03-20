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

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const PYTHON_BIN =
  process.env.WHISPER_PYTHON || '/Users/lytic/venvs/nanoclaw/bin/python3';

const TRANSCRIBE_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'scripts',
  'transcribe.py',
);

const TIMEOUT_MS = 60_000; // 60s max for transcription

export interface TranscriptionResult {
  text: string;
  language: string; // ISO 639-1 code (e.g. "en", "es", "ar", "zh")
  languageProbability: number;
}

/**
 * Transcribe an audio buffer (OGG/Opus from Telegram voice messages).
 * Returns transcript text, detected language, and confidence — or null on failure.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  ext = 'ogg',
): Promise<TranscriptionResult | null> {
  const tmpFile = path.join(os.tmpdir(), `nanoclaw-voice-${Date.now()}.${ext}`);

  try {
    fs.writeFileSync(tmpFile, audioBuffer);

    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Transcription timed out'));
      }, TIMEOUT_MS);

      const child = spawn(PYTHON_BIN, [TRANSCRIBE_SCRIPT, tmpFile], {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Whisper exited ${code}: ${stderr.trim()}`));
        } else {
          resolve(stdout.trim());
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const parsed = JSON.parse(raw) as {
      text: string;
      language: string;
      language_probability: number;
    };

    if (!parsed.text) return null;

    logger.info(
      {
        chars: parsed.text.length,
        lang: parsed.language,
        prob: parsed.language_probability,
      },
      'Transcribed voice message',
    );

    return {
      text: parsed.text,
      language: parsed.language,
      languageProbability: parsed.language_probability,
    };
  } catch (err) {
    logger.warn({ err }, 'Voice transcription failed');
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}
