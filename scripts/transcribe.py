#!/usr/bin/env python3
"""
Local Whisper transcription using faster-whisper.
Usage: python3 scripts/transcribe.py <audio_file>
Prints JSON to stdout: {"text": "...", "language": "en", "language_probability": 0.98}
Model is downloaded on first use (~74MB for tiny, ~244MB for base).
"""

import sys
import os
import json

def main():
    if len(sys.argv) < 2:
        print("Error: no audio file provided", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    if not os.path.exists(audio_file):
        print(f"Error: file not found: {audio_file}", file=sys.stderr)
        sys.exit(1)

    model_size = os.environ.get("WHISPER_MODEL", "base")

    from faster_whisper import WhisperModel

    # Use int8 quantization for speed on CPU/Apple Silicon
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_file, beam_size=5)

    text = " ".join(segment.text.strip() for segment in segments).strip()
    print(json.dumps({
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
    }))

if __name__ == "__main__":
    main()
