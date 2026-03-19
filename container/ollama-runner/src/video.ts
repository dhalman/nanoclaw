/**
 * Video generation backends for Jarvis.
 *
 * Backends:
 *   - ComfyUI  (localhost:8000) — workflow-based, LTX-Video / HunyuanVideo
 *   - OllamaDiffuser (localhost:8001) — REST API
 *
 * Context sources (auto-loaded when present):
 *   - .latest-image.json — reference images (I2V: first image used as start frame)
 *   - .latest-video.mp4  — reference video  (V2V: first frame extracted via ffmpeg)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const COMFYUI_HOST = process.env.COMFYUI_HOST || 'http://host.docker.internal:8000';
const OLLAMADIFFUSER_HOST = process.env.OLLAMADIFFUSER_HOST || 'http://host.docker.internal:8001';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';

const VIDEO_POLL_MS = 2000;
const VIDEO_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const LATEST_IMAGE_FILE = '/workspace/group/.latest-image.json';
const LATEST_VIDEO_FILE = '/workspace/group/.latest-video.json';
const LATEST_VIDEO_PATH = '/workspace/group/.latest-video.mp4';
const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function log(msg: string) {
  console.error(`[video] ${msg}`);
}

/** Describe a single image using llama3.2-vision. Returns description or fallback string. */
async function describeImageVision(imageBase64: string): Promise<string> {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5vl:72b',
        keep_alive: 60,
        messages: [{ role: 'user', content: 'Describe this image in detail: subject, appearance, colors, style, background. Be specific and thorough.', images: [imageBase64] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return '(description unavailable)';
    const data = await resp.json() as { message: { content: unknown } };
    const content = data.message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return (content as Array<unknown>)
        .map((b) => typeof b === 'string' ? b : (b as { text?: string }).text ?? '')
        .join('').trim();
    }
    return '(description unavailable)';
  } catch {
    return '(description unavailable)';
  }
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

/** Load the most recently saved images (from user's photo messages). */
export function loadReferenceImages(): string[] | null {
  try {
    if (!fs.existsSync(LATEST_IMAGE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(LATEST_IMAGE_FILE, 'utf-8')) as { images: string[]; savedAt: number };
    if (Date.now() - data.savedAt > CONTEXT_TTL_MS) return null;
    return data.images ?? null;
  } catch { return null; }
}

/**
 * Returns reference image(s) as base64 strings for use in I2I generation.
 * Priority: saved photos → first frame of reference video.
 * Returns null if no fresh context exists.
 */
export function getReferenceImages(): string[] | null {
  const images = loadReferenceImages();
  if (images?.length) return images;
  if (hasReferenceVideo()) {
    try {
      const frame = extractFirstFrame();
      return [frame.toString('base64')];
    } catch { /* ignore */ }
  }
  return null;
}

/** Check whether a reference video exists and is fresh. */
export function hasReferenceVideo(): boolean {
  try {
    if (!fs.existsSync(LATEST_VIDEO_FILE) || !fs.existsSync(LATEST_VIDEO_PATH)) return false;
    const data = JSON.parse(fs.readFileSync(LATEST_VIDEO_FILE, 'utf-8')) as { savedAt: number };
    return Date.now() - data.savedAt < CONTEXT_TTL_MS;
  } catch { return false; }
}

/** Extract the first frame of the reference video as a JPEG buffer via ffmpeg. */
function extractFirstFrame(): Buffer {
  const tmpOut = path.join(os.tmpdir(), `jarvis-frame-${Date.now()}.jpg`);
  try {
    execSync(`ffmpeg -i "${LATEST_VIDEO_PATH}" -vframes 1 -q:v 2 "${tmpOut}" -y`, {
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const buf = fs.readFileSync(tmpOut);
    return buf;
  } finally {
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

/** Transcode video buffer to h264/mp4 for Telegram compatibility. Returns original on failure. */
function transcodeToH264(input: Buffer): Buffer {
  const tmpIn = path.join(os.tmpdir(), `jarvis-in-${Date.now()}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `jarvis-out-${Date.now()}.mp4`);
  try {
    fs.writeFileSync(tmpIn, input);
    execSync(
      `ffmpeg -i "${tmpIn}" -vcodec libx264 -crf 23 -preset fast -acodec aac -movflags +faststart "${tmpOut}" -y`,
      { timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out = fs.readFileSync(tmpOut);
    log(`Transcoded to h264: ${input.length} → ${out.length} bytes`);
    return out;
  } catch (err) {
    log(`Transcode failed, using original: ${err instanceof Error ? err.message : String(err)}`);
    return input;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// ComfyUI helpers
// ---------------------------------------------------------------------------

/** Upload an image buffer to ComfyUI and return the server-side filename. */
async function uploadImageToComfyUI(imageBuffer: Buffer, filename = 'reference.jpg'): Promise<string> {
  const formData = new FormData();
  const uint8 = new Uint8Array(imageBuffer);
  formData.append('image', new Blob([uint8], { type: 'image/jpeg' }), filename);
  formData.append('overwrite', 'true');
  const resp = await fetch(`${COMFYUI_HOST}/upload/image`, { method: 'POST', body: formData });
  if (!resp.ok) throw new Error(`Image upload failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { name: string };
  return data.name;
}

/** Apply prompt variables into a workflow template (deep clone). */
function applyWorkflow(
  workflow: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  let json = JSON.stringify(workflow);
  for (const [key, val] of Object.entries(vars)) {
    json = json.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val.replace(/"/g, '\\"'));
  }
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// ComfyUI workflow templates
// ---------------------------------------------------------------------------

/**
 * LTX-Video 2B — Text-to-Video
 * Model: ltx-video-2b-v0.9.5.safetensors (or newer) → ComfyUI/models/checkpoints/
 * Uses built-in ComfyUI LTX nodes (no extra custom nodes needed).
 */
const LTX_T2V: Record<string, unknown> = {
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "ltx-video-2b-v0.9.5.safetensors" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{POSITIVE}}", "clip": ["1", 1] } },
  "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{NEGATIVE}}", "clip": ["1", 1] } },
  "4": { "class_type": "LTXVConditioning", "inputs": { "positive": ["2", 0], "negative": ["3", 0], "frame_rate": 25 } },
  "5": { "class_type": "ModelSamplingLTXV", "inputs": { "model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95 } },
  "6": { "class_type": "EmptyLTXVLatentVideo", "inputs": { "width": 704, "height": 480, "length": 97, "batch_size": 1 } },
  "7": { "class_type": "LTXVScheduler", "inputs": { "steps": 30, "max_shift": 2.05, "base_shift": 0.95, "stretch": true, "terminal": 0.1, "latent": ["6", 0] } },
  "8": { "class_type": "RandomNoise", "inputs": { "noise_seed": "{{SEED}}" } },
  "9": { "class_type": "BasicGuider", "inputs": { "model": ["5", 0], "conditioning": ["4", 0] } },
  "10": { "class_type": "KSamplerSelect", "inputs": { "sampler_name": "euler" } },
  "11": { "class_type": "SamplerCustomAdvanced", "inputs": { "noise": ["8", 0], "guider": ["9", 0], "sampler": ["10", 0], "sigmas": ["7", 0], "latent_image": ["6", 0] } },
  "12": { "class_type": "VAEDecode", "inputs": { "samples": ["11", 0], "vae": ["1", 2] } },
  "13": { "class_type": "CreateVideo", "inputs": { "images": ["12", 0], "fps": 25 } },
  "14": { "class_type": "SaveVideo", "inputs": { "video": ["13", 0], "filename_prefix": "jarvis_ltx", "format": "auto" } },
};

/**
 * LTX-Video 2B — Image-to-Video
 * Uses LTXVImgToVideo node (built-in).
 */
const LTX_I2V: Record<string, unknown> = {
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "ltx-video-2b-v0.9.5.safetensors" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{POSITIVE}}", "clip": ["1", 1] } },
  "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{NEGATIVE}}", "clip": ["1", 1] } },
  "4": { "class_type": "LoadImage", "inputs": { "image": "{{REF_IMAGE}}" } },
  "5": { "class_type": "LTXVImgToVideo", "inputs": { "positive": ["2", 0], "negative": ["3", 0], "vae": ["1", 2], "image": ["4", 0], "width": 704, "height": 480, "length": 97, "batch_size": 1, "strength": 1.0 } },
  "6": { "class_type": "ModelSamplingLTXV", "inputs": { "model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95 } },
  "7": { "class_type": "LTXVScheduler", "inputs": { "steps": 30, "max_shift": 2.05, "base_shift": 0.95, "stretch": true, "terminal": 0.1, "latent": ["5", 2] } },
  "8": { "class_type": "RandomNoise", "inputs": { "noise_seed": "{{SEED}}" } },
  "9": { "class_type": "BasicGuider", "inputs": { "model": ["6", 0], "conditioning": ["5", 0] } },
  "10": { "class_type": "KSamplerSelect", "inputs": { "sampler_name": "euler" } },
  "11": { "class_type": "SamplerCustomAdvanced", "inputs": { "noise": ["8", 0], "guider": ["9", 0], "sampler": ["10", 0], "sigmas": ["7", 0], "latent_image": ["5", 2] } },
  "12": { "class_type": "VAEDecode", "inputs": { "samples": ["11", 0], "vae": ["1", 2] } },
  "13": { "class_type": "CreateVideo", "inputs": { "images": ["12", 0], "fps": 25 } },
  "14": { "class_type": "SaveVideo", "inputs": { "video": ["13", 0], "filename_prefix": "jarvis_ltx_i2v", "format": "auto" } },
};

/** Registry: text-to-video workflows. Checked in order (checkpoint name must exist in ComfyUI). */
const T2V_WORKFLOWS = [
  { checkpoint: 'ltx-video-2b-v0.9.5.safetensors', template: LTX_T2V, label: 'LTX-Video 2B (T2V)' },
];

/** Registry: image-to-video workflows. Checked in order. */
const I2V_WORKFLOWS = [
  { checkpoint: 'ltx-video-2b-v0.9.5.safetensors', template: LTX_I2V, label: 'LTX-Video 2B (I2V)' },
];

// ---------------------------------------------------------------------------
// ComfyUI backend
// ---------------------------------------------------------------------------

async function comfyuiAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${COMFYUI_HOST}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch { return false; }
}

/** Return combined labels for ComfyUI video checkpoints that are installed, merging T2V/I2V modes. */
export async function listComfyVideoModels(): Promise<string[]> {
  try {
    const resp = await fetch(`${COMFYUI_HOST}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json() as Record<string, { input?: { required?: { ckpt_name?: [string[]] } } }>;
    const ckpts: string[] = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    const available = new Set(ckpts);
    // Map checkpoint → set of modes (T2V / I2V)
    const byCheckpoint = new Map<string, { baseName: string; modes: Set<string> }>();
    for (const def of T2V_WORKFLOWS) {
      if (!available.has(def.checkpoint)) continue;
      const baseName = def.label.replace(/\s*\(T2V\)/, '');
      if (!byCheckpoint.has(def.checkpoint)) byCheckpoint.set(def.checkpoint, { baseName, modes: new Set() });
      byCheckpoint.get(def.checkpoint)!.modes.add('T2V');
    }
    for (const def of I2V_WORKFLOWS) {
      if (!available.has(def.checkpoint)) continue;
      const baseName = def.label.replace(/\s*\(I2V\)/, '');
      if (!byCheckpoint.has(def.checkpoint)) byCheckpoint.set(def.checkpoint, { baseName, modes: new Set() });
      byCheckpoint.get(def.checkpoint)!.modes.add('I2V');
    }
    return Array.from(byCheckpoint.values()).map(({ baseName, modes }) =>
      modes.size > 1 ? `${baseName} (T2V + I2V)` : `${baseName} (${[...modes][0]})`
    );
  } catch { return []; }
}

async function comfyCheckpointAvailable(name: string): Promise<boolean> {
  try {
    const resp = await fetch(`${COMFYUI_HOST}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return false;
    const data = await resp.json() as Record<string, { input?: { required?: { ckpt_name?: [string[]] } } }>;
    const ckpts: string[] = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    return ckpts.includes(name);
  } catch { return false; }
}

async function comfyQueuePrompt(workflow: Record<string, unknown>): Promise<string> {
  const resp = await fetch(`${COMFYUI_HOST}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `jarvis-${Date.now()}` }),
  });
  if (!resp.ok) throw new Error(`ComfyUI queue error: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { prompt_id: string }).prompt_id;
}

async function comfyWaitForCompletion(promptId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_MS));
    const resp = await fetch(`${COMFYUI_HOST}/history/${promptId}`);
    if (!resp.ok) continue;
    const history = await resp.json() as Record<string, { outputs: Record<string, unknown>; status: { status_str: string } }>;
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI workflow failed');
    if (entry.outputs && Object.keys(entry.outputs).length > 0) return entry.outputs;
  }
  throw new Error('ComfyUI timed out after 5 minutes');
}

function extractVideoFile(outputs: Record<string, unknown>): { filename: string; subfolder: string; type: string } | null {
  for (const nodeOutput of Object.values(outputs)) {
    const out = nodeOutput as Record<string, unknown>;
    const videos = out.videos as Array<{ filename: string; subfolder: string; type: string }> | undefined;
    if (videos?.length) return videos[0];
    const gifs = out.gifs as Array<{ filename: string; subfolder: string; type: string }> | undefined;
    if (gifs?.length) return gifs[0];
  }
  return null;
}

export async function generateVideoComfyUI(
  prompt: string,
  refImageBuffers?: Buffer[],
): Promise<{ buffer: Buffer; label: string }> {
  if (!(await comfyuiAvailable())) throw new Error('ComfyUI is not running. Open ComfyUI Desktop first.');

  const seed = String(Math.floor(Math.random() * 2 ** 32));
  const negative = 'worst quality, inconsistent motion, blurry, jittery, distorted';

  // Build effective prompt: prepend descriptions of extra reference images (indices 1+)
  let effectivePrompt = prompt;
  const startFrameBuffer = refImageBuffers?.[0];
  if (refImageBuffers && refImageBuffers.length > 1) {
    log(`Describing ${refImageBuffers.length - 1} additional reference image(s) for context...`);
    const extraDescriptions: string[] = [];
    for (let i = 1; i < refImageBuffers.length; i++) {
      const desc = await describeImageVision(refImageBuffers[i].toString('base64'));
      extraDescriptions.push(`Reference image ${i + 1}: ${desc}`);
    }
    effectivePrompt = `${extraDescriptions.join('\n\n')}\n\nVideo prompt: ${prompt}`;
    log(`Multi-image context prepended (${refImageBuffers.length - 1} extra image(s))`);
  }

  const vars: Record<string, string> = { POSITIVE: effectivePrompt, NEGATIVE: negative, SEED: seed };

  // Try I2V workflows first when we have a start frame
  if (startFrameBuffer) {
    for (const def of I2V_WORKFLOWS) {
      if (!(await comfyCheckpointAvailable(def.checkpoint))) continue;
      log(`Using ${def.label}`);
      const refFilename = await uploadImageToComfyUI(startFrameBuffer, 'jarvis_ref.jpg');
      const workflow = applyWorkflow(def.template, { ...vars, REF_IMAGE: refFilename });
      const promptId = await comfyQueuePrompt(workflow);
      log(`Queued ${promptId}`);
      const outputs = await comfyWaitForCompletion(promptId);
      const videoFile = extractVideoFile(outputs);
      if (!videoFile) throw new Error('ComfyUI returned no video output');
      log(`Downloading ${videoFile.filename}`);
      const viewUrl = `${COMFYUI_HOST}/view?filename=${encodeURIComponent(videoFile.filename)}&subfolder=${encodeURIComponent(videoFile.subfolder)}&type=${videoFile.type}`;
      const videoResp = await fetch(viewUrl);
      if (!videoResp.ok) throw new Error(`Download failed: ${videoResp.status}`);
      return { buffer: transcodeToH264(Buffer.from(await videoResp.arrayBuffer())), label: def.label };
    }
    log('No I2V workflow found; falling back to T2V with reference description');
  }

  // T2V workflows
  for (const def of T2V_WORKFLOWS) {
    if (!(await comfyCheckpointAvailable(def.checkpoint))) continue;
    log(`Using ${def.label}`);
    const workflow = applyWorkflow(def.template, vars);
    const promptId = await comfyQueuePrompt(workflow);
    log(`Queued ${promptId}`);
    const outputs = await comfyWaitForCompletion(promptId);
    const videoFile = extractVideoFile(outputs);
    if (!videoFile) throw new Error('ComfyUI returned no video output');
    log(`Downloading ${videoFile.filename}`);
    const viewUrl = `${COMFYUI_HOST}/view?filename=${encodeURIComponent(videoFile.filename)}&subfolder=${encodeURIComponent(videoFile.subfolder)}&type=${videoFile.type}`;
    const videoResp = await fetch(viewUrl);
    if (!videoResp.ok) throw new Error(`Download failed: ${videoResp.status}`);
    return { buffer: transcodeToH264(Buffer.from(await videoResp.arrayBuffer())), label: def.label };
  }

  throw new Error(
    'No supported video model found in ComfyUI.\n\nDownload ltx-video-2b-v0.9.5.safetensors into ComfyUI/models/checkpoints/',
  );
}

// ---------------------------------------------------------------------------
// OllamaDiffuser backend
// ---------------------------------------------------------------------------

async function ollamaDiffuserAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMADIFFUSER_HOST}/api/models`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch { return false; }
}

/** Return all model names reported by OllamaDiffuser. Empty array if unavailable. */
export async function listOllamaDiffuserModels(): Promise<string[]> {
  try {
    const resp = await fetch(`${OLLAMADIFFUSER_HOST}/api/models`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json() as Record<string, unknown>;
    // OllamaDiffuser returns { available: string[], installed: string[] }
    // Prefer installed (actually downloaded), fall back to available
    const installed = data.installed;
    if (Array.isArray(installed) && installed.length > 0) {
      return installed.filter((m): m is string => typeof m === 'string');
    }
    const available = data.available;
    if (Array.isArray(available)) {
      return available.filter((m): m is string => typeof m === 'string');
    }
    // Legacy format: { models: [{ name: "..." }] } or [{ name: "..." }]
    if (Array.isArray(data)) return (data as Array<{ name: string }>).map((m) => m.name).filter(Boolean);
    const models = data.models;
    if (Array.isArray(models)) return (models as Array<{ name: string }>).map((m) => m.name).filter(Boolean);
    return [];
  } catch { return []; }
}

const VIDEO_KEYWORDS = ['video', 'animate', 'wan', 'ltx', 'cogvideo', 'motion'];

/** Return combined labels for OllamaDiffuser video models. All support T2V + I2V (image is optional). */
export async function listOllamaDiffuserVideoModels(): Promise<string[]> {
  const models = await listOllamaDiffuserModels();
  return models
    .filter((name) => VIDEO_KEYWORDS.some((k) => name.toLowerCase().includes(k)))
    .map((name) => `${name} (T2V + I2V)`);
}

async function detectOllamaDiffuserVideoModel(): Promise<string | null> {
  const models = await listOllamaDiffuserModels();
  return models.find((name) => VIDEO_KEYWORDS.some((k) => name.toLowerCase().includes(k))) ?? null;
}

export async function generateVideoOllamaDiffuser(prompt: string, refImageBase64?: string): Promise<{ buffer: Buffer; label: string }> {
  if (!(await ollamaDiffuserAvailable())) throw new Error('OllamaDiffuser is not running (port 8001).');
  const videoModel = await detectOllamaDiffuserVideoModel();
  if (!videoModel) throw new Error('No video model found in OllamaDiffuser.');

  log(`OllamaDiffuser: ${videoModel}`);
  const body: Record<string, unknown> = { prompt, model: videoModel, num_inference_steps: 30 };
  if (refImageBase64) body.image = refImageBase64;

  const resp = await fetch(`${OLLAMADIFFUSER_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`OllamaDiffuser error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { video?: string; image?: string };
  const b64 = data.video ?? data.image;
  if (!b64) throw new Error('OllamaDiffuser returned no video');
  return { buffer: Buffer.from(b64, 'base64'), label: `OllamaDiffuser (${videoModel})` };
}

// ---------------------------------------------------------------------------
// Unified entry point — resolves reference context then generates
// ---------------------------------------------------------------------------

export type VideoBackend = 'comfyui' | 'ollamadiffuser' | 'auto';

export async function generateVideo(
  prompt: string,
  backend: VideoBackend = 'auto',
  options?: { useReference?: boolean },
): Promise<{ buffer: Buffer; source: string; usedContext: string; effectivePrompt: string }> {
  const useRef = options?.useReference !== false; // default true

  let refImageBuffers: Buffer[] = [];
  let refImageBase64: string | undefined;
  let usedContext = 'none';

  if (useRef) {
    const refImages = loadReferenceImages();
    if (refImages?.length) {
      refImageBuffers = refImages.map((b64) => Buffer.from(b64, 'base64'));
      refImageBase64 = refImages[0];
      usedContext = `${refImages.length} image(s)`;
      log(`Using ${refImages.length} reference image(s) for I2V`);
    } else if (hasReferenceVideo()) {
      try {
        log('Extracting first frame from reference video...');
        const frame = extractFirstFrame();
        refImageBuffers = [frame];
        refImageBase64 = frame.toString('base64');
        usedContext = 'video (first frame)';
        log(`Extracted reference frame: ${frame.length} bytes`);
      } catch (err) {
        log(`Frame extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    log('Reference context skipped (use_reference=false)');
  }

  let effectivePrompt = prompt;
  const errors: string[] = [];

  if (backend === 'comfyui' || backend === 'auto') {
    try {
      const result = await generateVideoComfyUI(prompt, refImageBuffers.length ? refImageBuffers : undefined);
      if (refImageBuffers.length > 1) effectivePrompt = `[${refImageBuffers.length - 1} extra image(s) described as context] ${prompt}`;
      return { buffer: result.buffer, source: result.label, usedContext, effectivePrompt };
    } catch (err) {
      errors.push(`ComfyUI: ${err instanceof Error ? err.message : String(err)}`);
      log(`ComfyUI failed: ${errors[errors.length - 1]}`);
    }
  }

  if (backend === 'ollamadiffuser' || backend === 'auto') {
    try {
      const result = await generateVideoOllamaDiffuser(prompt, refImageBase64);
      return { buffer: result.buffer, source: result.label, usedContext, effectivePrompt };
    } catch (err) {
      errors.push(`OllamaDiffuser: ${err instanceof Error ? err.message : String(err)}`);
      log(`OllamaDiffuser failed: ${errors[errors.length - 1]}`);
    }
  }

  throw new Error(`Video generation failed:\n${errors.join('\n')}`);
}
