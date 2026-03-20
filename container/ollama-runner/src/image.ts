/**
 * Image generation backends for Jarvis.
 *
 * Backends (tried in order):
 *   1. ComfyUI (localhost:8000) — z_image_turbo FLUX workflow
 *   2. OllamaDiffuser (localhost:8001) — FLUX.2-klein, FLUX.1-dev, SDXL-Turbo, SD3
 *   3. Ollama (localhost:11434) — x/flux2-klein fallback
 *
 * Context sources (auto-loaded when present):
 *   - .latest-image.json — reference images for image-to-image editing
 */

import fs from 'fs';

const COMFYUI_HOST = process.env.COMFYUI_HOST || 'http://host.docker.internal:8000';
const OLLAMADIFFUSER_HOST = process.env.OLLAMADIFFUSER_HOST || 'http://host.docker.internal:8001';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';

const LATEST_IMAGE_FILE = '/workspace/group/.latest-image.json';
const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Preference order for image models in OllamaDiffuser (best first).
 *
 * Recommended models by use case:
 *   Best quality:     flux.1-dev (slow, 12GB VRAM), stable-diffusion-3.5-large (slow, 8GB)
 *   Best speed:       flux.2-klein-4b (fast, 4GB), sdxl-turbo (very fast, 4GB)
 *   Best balance:     flux.1-schnell (good quality, fast), stable-diffusion-3.5-medium (good, 4GB)
 *   Best for I2I:     flux.2-klein-4b, flux.1-dev (both support image conditioning)
 *   Style/artistic:   hidream-i1-dev (stylized), pixart-sigma (painterly)
 *   Photorealistic:   realvisxl-v4, realistic-vision-v6, dreamshaper
 *   GGUF (low VRAM):  flux.1-dev-gguf-q4ks (2.5GB), flux.1-schnell-gguf-q4ks (2.5GB)
 */
const IMAGE_MODEL_PREFERENCE = [
  'flux.2-klein-4b',
  'flux.1-dev',
  'flux.1-schnell',
  'sdxl-turbo',
  'stable-diffusion-3.5-large-turbo-f16',
  'stable-diffusion-3.5-medium',
  'hidream-i1-dev',
  'pixart-sigma',
  'realvisxl-v4',
  'stable-diffusion-3',
];

function log(msg: string) {
  console.error(`[image] ${msg}`);
}

export function loadReferenceImages(): string[] | null {
  try {
    if (!fs.existsSync(LATEST_IMAGE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(LATEST_IMAGE_FILE, 'utf-8')) as {
      images: string[];
      savedAt: number;
    };
    if (Date.now() - data.savedAt > CONTEXT_TTL_MS) return null;
    return data.images ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ComfyUI backend — FLUX workflow using z_image_turbo_bf16 UNET
// ---------------------------------------------------------------------------
//
// Required models (install via comfyui_install_model or ComfyUI Manager):
//   UNET:  z_image_turbo_bf16.safetensors → ComfyUI/models/unet/
//   CLIP:  clip_l.safetensors             → ComfyUI/models/clip/
//   CLIP:  t5xxl_fp16.safetensors         → ComfyUI/models/clip/
//   VAE:   ae.safetensors                 → ComfyUI/models/vae/
//
// Recommended additional models:
//   LoRAs (ComfyUI/models/loras/):
//     - FLUX.1 detail enhancer LoRA — sharpens details in FLUX generations
//     - FLUX.1 realism LoRA — pushes FLUX toward photorealism
//   Upscalers (ComfyUI/models/upscale_models/):
//     - 4x-UltraSharp.pth — best general-purpose upscaler
//     - RealESRGAN_x4plus.pth — photorealistic upscaling
//   ControlNet (ComfyUI/models/controlnet/):
//     - FLUX.1-canny-dev — edge-guided generation
//     - FLUX.1-depth-dev — depth-guided generation
//
// For video, see video.ts — requires ltx-video-2b-v0.9.5.safetensors in checkpoints/

/**
 * FLUX T2I workflow:
 *   UNETLoader (z_image_turbo_bf16) + DualCLIPLoader (clip_l + t5xxl) + VAELoader (ae)
 *   → CLIPTextEncodeFlux → FluxGuidance → KSampler → VAEDecode → SaveImage
 */
const FLUX_T2I: Record<string, unknown> = {
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default" } },
  "2": { "class_type": "DualCLIPLoader", "inputs": { "clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux" } },
  "3": { "class_type": "VAELoader", "inputs": { "vae_name": "ae.safetensors" } },
  "4": { "class_type": "CLIPTextEncodeFlux", "inputs": { "clip": ["2", 0], "clip_l": "{{POSITIVE}}", "t5xxl": "{{POSITIVE}}", "guidance": 3.5 } },
  "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "" } },
  "6": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
  "7": { "class_type": "FluxGuidance", "inputs": { "conditioning": ["4", 0], "guidance": 3.5 } },
  "8": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "positive": ["7", 0], "negative": ["5", 0], "latent_image": ["6", 0], "seed": "{{SEED}}", "steps": 20, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0 } },
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["3", 0] } },
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "jarvis_flux" } },
};

function applyWorkflow(workflow: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  let json = JSON.stringify(workflow);
  for (const [key, val] of Object.entries(vars)) {
    json = json.replace(new RegExp(`"\\{\\{${key}\\}\\}"`, 'g'), JSON.stringify(val));
    json = json.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val.replace(/"/g, '\\"'));
  }
  return JSON.parse(json);
}

async function comfyuiAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${COMFYUI_HOST}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch { return false; }
}

async function comfyCheckpointAvailable(unetName: string): Promise<boolean> {
  try {
    const resp = await fetch(`${COMFYUI_HOST}/object_info/UNETLoader`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return false;
    const data = await resp.json() as Record<string, { input?: { required?: { unet_name?: [string[]] } } }>;
    const models: string[] = data?.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
    return models.includes(unetName);
  } catch { return false; }
}

async function comfyQueuePrompt(workflow: Record<string, unknown>): Promise<string> {
  const resp = await fetch(`${COMFYUI_HOST}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `jarvis-img-${Date.now()}` }),
  });
  if (!resp.ok) throw new Error(`ComfyUI queue error: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { prompt_id: string }).prompt_id;
}

async function comfyWaitForImage(promptId: string): Promise<{ filename: string; subfolder: string; type: string }> {
  const deadline = Date.now() + 120_000; // 2 minutes
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const resp = await fetch(`${COMFYUI_HOST}/history/${promptId}`);
    if (!resp.ok) continue;
    const history = await resp.json() as Record<string, { outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>; status: { status_str: string } }>;
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI workflow failed');
    for (const nodeOut of Object.values(entry.outputs ?? {})) {
      if (nodeOut.images?.length) return nodeOut.images[0];
    }
  }
  throw new Error('ComfyUI timed out');
}

export async function generateImageComfyUI(prompt: string): Promise<{ buffer: Buffer; model: string }> {
  if (!(await comfyuiAvailable())) throw new Error('ComfyUI is not running.');
  if (!(await comfyCheckpointAvailable('z_image_turbo_bf16.safetensors')))
    throw new Error('z_image_turbo_bf16 not found in ComfyUI.');

  const seed = String(Math.floor(Math.random() * 2 ** 32));
  const workflow = applyWorkflow(FLUX_T2I, { POSITIVE: prompt, SEED: seed });
  log(`ComfyUI: queuing FLUX workflow`);
  const promptId = await comfyQueuePrompt(workflow);
  const imageFile = await comfyWaitForImage(promptId);
  log(`ComfyUI: downloading ${imageFile.filename}`);
  const viewUrl = `${COMFYUI_HOST}/view?filename=${encodeURIComponent(imageFile.filename)}&subfolder=${encodeURIComponent(imageFile.subfolder)}&type=${imageFile.type}`;
  const imgResp = await fetch(viewUrl);
  if (!imgResp.ok) throw new Error(`Download failed: ${imgResp.status}`);
  return { buffer: Buffer.from(await imgResp.arrayBuffer()), model: 'z_image_turbo (FLUX)' };
}

// ---------------------------------------------------------------------------
// OllamaDiffuser backend
// ---------------------------------------------------------------------------

async function ollamaDiffuserAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMADIFFUSER_HOST}/api/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function listOllamaDiffuserImageModels(): Promise<string[]> {
  try {
    const resp = await fetch(`${OLLAMADIFFUSER_HOST}/api/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as
      | { models?: Array<{ name: string }> }
      | Array<{ name: string }>;
    const models: Array<{ name: string }> = Array.isArray(data)
      ? data
      : (data.models ?? []);
    return models.map((m) => m.name).filter(Boolean);
  } catch {
    return [];
  }
}

async function pickImageModel(): Promise<string | null> {
  const available = await listOllamaDiffuserImageModels();
  if (!available.length) return null;
  for (const preferred of IMAGE_MODEL_PREFERENCE) {
    const match = available.find((m) => m.toLowerCase().includes(preferred));
    if (match) return match;
  }
  return available[0]; // fallback to whatever is first
}

export async function generateImageOllamaDiffuser(
  prompt: string,
  refImageBase64?: string,
): Promise<{ buffer: Buffer; model: string }> {
  if (!(await ollamaDiffuserAvailable()))
    throw new Error('OllamaDiffuser is not running (port 8001).');

  const model = await pickImageModel();
  if (!model) throw new Error('No image model found in OllamaDiffuser.');

  log(`OllamaDiffuser: ${model}`);
  const body: Record<string, unknown> = { model, prompt };
  if (refImageBase64) body.image = refImageBase64;

  const resp = await fetch(`${OLLAMADIFFUSER_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok)
    throw new Error(`OllamaDiffuser error: ${resp.status} ${await resp.text()}`);

  const data = (await resp.json()) as { image?: string; images?: string[]; response?: string };
  const b64 = data.image ?? data.images?.[0] ?? data.response;
  if (!b64) throw new Error('OllamaDiffuser returned no image');

  return { buffer: Buffer.from(b64, 'base64'), model };
}

// ---------------------------------------------------------------------------
// Ollama backend (fallback)
// ---------------------------------------------------------------------------

export async function generateImageOllama(
  model: string,
  prompt: string,
): Promise<{ buffer: Buffer; model: string }> {
  const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`Ollama image gen error: ${resp.status}`);
  const data = (await resp.json()) as {
    image?: string;
    images?: string[];
    response?: string;
  };
  const b64 = data.image ?? data.images?.[0] ?? data.response;
  if (!b64) throw new Error('No image in Ollama response');
  return { buffer: Buffer.from(b64, 'base64'), model };
}

// ---------------------------------------------------------------------------
// Prompt enhancement via Ollama
// ---------------------------------------------------------------------------

export async function enhancePrompt(prompt: string): Promise<string> {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5vl:72b',
        keep_alive: 60,
        messages: [
          {
            role: 'system',
            content: `You are a professional creative director and visual artist specialising in AI image generation with Flux diffusion models. Transform the user's rough idea into a precise, richly detailed generation prompt.

Your expertise:
- Art movements: impressionism, expressionism, surrealism, art nouveau, minimalism, maximalism, baroque, renaissance
- Digital styles: concept art, illustration, photorealism, anime, manga, 3D render, pixel art, watercolour, oil painting, pencil sketch
- Photography: portrait, landscape, macro, wide angle, golden hour, bokeh, studio, rim light, dramatic shadows, volumetric light
- Composition: rule of thirds, leading lines, depth of field, foreground/midground/background layering, negative space
- Colour theory: complementary, monochromatic, warm/cool contrast, cinematic colour grading, muted tones, vibrant saturation
- Lighting: natural, golden hour, blue hour, overcast, dramatic, side-lit, backlit, rim light, neon glow, candlelight
- Quality: 8k, ultra-detailed, sharp focus, intricate textures, masterpiece, professional photography, award-winning

Output ONLY the enhanced prompt — no explanation, no quotes, no preamble. Be specific and vivid.`,
          },
          { role: 'user', content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return prompt;
    const data = (await resp.json()) as {
      message: { content: string | Array<{ text?: string }> };
    };
    const content = data.message.content;
    const text =
      typeof content === 'string'
        ? content.trim()
        : (content as Array<{ text?: string }>)
            .map((b) => b.text ?? '')
            .join('')
            .trim();
    return text || prompt;
  } catch {
    return prompt;
  }
}

// ---------------------------------------------------------------------------
// Reference image description via vision model
// ---------------------------------------------------------------------------

export async function describeImages(images: string[]): Promise<string[]> {
  return Promise.all(
    images.map(async (img, i) => {
      try {
        const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen2.5vl:72b',
            keep_alive: 60,
            messages: [
              {
                role: 'user',
                content:
                  'Describe this image in detail: subject, appearance, clothing, colors, background, lighting, style. Be specific and thorough.',
                images: [img],
              },
            ],
            stream: false,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
          message: { content: string | Array<{ text?: string }> };
        };
        const content = data.message.content;
        return typeof content === 'string'
          ? content.trim()
          : (content as Array<{ text?: string }>)
              .map((b) => b.text ?? '')
              .join('')
              .trim();
      } catch {
        return null;
      }
    }),
  ).then((results) =>
    results
      .map((desc, i) =>
        desc ? (images.length > 1 ? `Character ${i + 1}: ${desc}` : desc) : null,
      )
      .filter((d): d is string => d !== null),
  );
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

export type ImageBackend = 'comfyui' | 'ollamadiffuser' | 'ollama' | 'auto';

export async function generateImage(
  ollamaModel: string,
  prompt: string,
  backend: ImageBackend = 'auto',
  options?: { useReference?: boolean; embellish?: boolean },
): Promise<{ buffer: Buffer; source: string }> {
  const useRef = options?.useReference !== false;
  const embellish = options?.embellish !== false;

  // Load reference images
  let refImageBase64: string | undefined;
  const savedImages = useRef ? loadReferenceImages() : null;

  // Build prompt from reference image descriptions
  let finalPrompt = prompt;
  if (savedImages?.length) {
    log(`Describing ${savedImages.length} reference image(s)...`);
    const descriptions = await describeImages(savedImages);
    if (descriptions.length) {
      finalPrompt = `${descriptions.join('\n\n')}. Modification: ${prompt}`;
      log(`Vision+edit prompt: ${finalPrompt.slice(0, 120)}`);
    }
    refImageBase64 = savedImages[0]; // first image for i2i
  }

  // Optionally enhance prompt
  if (embellish) {
    log('Enhancing prompt...');
    finalPrompt = await enhancePrompt(finalPrompt);
    log(`Enhanced: ${finalPrompt.slice(0, 120)}`);
  }

  const errors: string[] = [];

  // ComfyUI: text-to-image only (no i2i support yet)
  if ((backend === 'comfyui' || backend === 'auto') && !refImageBase64) {
    try {
      const result = await generateImageComfyUI(finalPrompt);
      return { buffer: result.buffer, source: `ComfyUI (${result.model})` };
    } catch (err) {
      errors.push(`ComfyUI: ${err instanceof Error ? err.message : String(err)}`);
      log(`ComfyUI failed: ${errors[errors.length - 1]}`);
    }
  }

  if (backend === 'ollamadiffuser' || backend === 'auto') {
    try {
      const result = await generateImageOllamaDiffuser(finalPrompt, refImageBase64);
      return { buffer: result.buffer, source: `OllamaDiffuser (${result.model})` };
    } catch (err) {
      errors.push(`OllamaDiffuser: ${err instanceof Error ? err.message : String(err)}`);
      log(`OllamaDiffuser failed: ${errors[errors.length - 1]}`);
    }
  }

  if (backend === 'ollama' || backend === 'auto') {
    try {
      const result = await generateImageOllama(ollamaModel, finalPrompt);
      return { buffer: result.buffer, source: `Ollama (${result.model})` };
    } catch (err) {
      errors.push(`Ollama: ${err instanceof Error ? err.message : String(err)}`);
      log(`Ollama failed: ${errors[errors.length - 1]}`);
    }
  }

  throw new Error(`Image generation failed:\n${errors.join('\n')}`);
}
