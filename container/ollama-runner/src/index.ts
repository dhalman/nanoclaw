/**
 * NanoClaw Ollama Runner
 * Runs inside the container, calls Ollama API directly — no Claude Code.
 * Input/output format identical to agent-runner for host compatibility.
 *
 * Model selection:
 *   - Vision tasks  → qwen2.5vl:72b (Artist/Cinematographer)
 *   - Coding tasks  → qwen3-coder:30b
 *   - Everything else → qwen3.5:35b (escalates to thinking, then deepseek-r1 as needed)
 *
 * Escalation ladder: qwen3.5:35b → qwen3.5:35b+think → deepseek-r1:70b
 *
 * Tools available to all models (via Ollama tool-calling):
 *   - ollama_list_models: list installed models
 *   - ollama_generate: call any local model for a subtask
 *
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { generateVideo, getReferenceImages, hasReferenceVideo, listComfyVideoModels, listOllamaDiffuserVideoModels } from './video.js';
import { generateImage, loadReferenceImages, type ImageBackend } from './image.js';
import { logPerf, summarizePerf } from './perf-log.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  images?: string[]; // base64-encoded images for visual context
  prespin?: boolean; // pre-spawn mode: skip first inference, wait for IPC message
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
}

interface OllamaResponse {
  message: {
    role: string;
    content: unknown; // may be string or array depending on model/version
    thinking?: string; // extended thinking content (qwen3 with think: true)
    tool_calls?: ToolCall[];
  };
  done: boolean;
}

const OLLAMA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ollama_list_models',
      description: 'List all locally installed Ollama text/reasoning models with their sizes in GB. Returns every model available on the local Ollama server (localhost:11434). Use before ollama_generate to check what is installed, or before ollama_pull to avoid re-downloading. Models are managed entirely at runtime — no rebuild needed. The list includes all model variants (e.g. "qwen3.5:35b", "deepseek-r1:70b"). To browse models not yet installed, use web_search to search ollama.com/library.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ollama_pull',
      description: 'Download a model from the Ollama registry (ollama.com/library). Blocks until the download fully completes — large models (30b+) can take several minutes depending on connection speed. No rebuild needed. Once pulled, the model is immediately available for use via ollama_generate. Check ollama_list_models first to see if the model is already installed. If the model name includes a tag (e.g. "llama3.2:13b"), that specific variant is pulled; without a tag, the default variant is used. Progress is not streamed — the call simply returns when done.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Model name and optional tag. Examples: "gemma3:27b", "llama3.2", "deepseek-r1:14b", "qwen3-coder:30b", "phi4:14b". Same format as the `ollama pull` CLI command. Browse available models at ollama.com/library.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ollama_remove',
      description: 'Permanently delete an installed Ollama model from disk. Frees the disk space used by the model weights. The model must be re-pulled if needed again. Use when the user wants to clean up models they no longer need, or to free space before pulling a larger model. The name must exactly match the output of ollama_list_models (including the tag, e.g. "llama3.2:13b" not just "llama3.2").',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact model name including tag (e.g. "llama3.2:13b", "deepseek-r1:70b"). Must match ollama_list_models output exactly.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diffuser_list_models',
      description: `List all OllamaDiffuser image and video models. Returns two sections: Installed (ready to use now, already on disk) and Available (can be used — auto-downloads on first generation, no separate pull needed). OllamaDiffuser handles FLUX, Stable Diffusion, PixArt, HiDream, CogView, HunyuanVideo, LTX-Video, and more.

Model categories:
• Image models: flux.2-klein-4b (fastest), flux.1-dev (highest quality), sdxl-turbo (fast), stable-diffusion-3.5-*, pixart-sigma, hidream-*, sana-1.5, cogview4, kolors, lumina-2, auraflow, omnigen
• Video models: ltx-video-2b, hunyuan-video, hunyuan-video-i2v (image-to-video)
• ControlNet: controlnet-canny-*, controlnet-depth-*, controlnet-openpose-*, controlnet-scribble-* (for SD1.5/SDXL)
• GGUF variants: flux.1-dev-gguf-q4ks etc. — quantized versions that use less VRAM at slightly lower quality

To use any available model: just call generate_art, generate_video, or ollama_generate with the model name. If not installed, it downloads automatically. Current image preference order: flux.2-klein-4b > flux.1-dev > sdxl-turbo > pixart-sigma > stable-diffusion-3.`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'comfyui_list_models',
      description: `List all models currently installed in ComfyUI, grouped by type. ComfyUI is the advanced workflow engine used for highest-quality image and video generation.

Model types returned:
• Checkpoints: full model weights (e.g. ltx-video-2b-v0.9.5.safetensors for video, SD/SDXL checkpoints for images)
• UNETs: FLUX architecture models (e.g. z_image_turbo_bf16.safetensors — the primary image generation model)
• LoRAs: style/concept adapters that modify a base model's output (applied on top of a checkpoint or UNET)

ComfyUI models live on the host filesystem in ComfyUI/models/{checkpoints,unet,loras,vae,clip,vae_approx}/. To add new models, use comfyui_search_models to find them in the 527+ model catalog, then comfyui_install_model to download. Models are available immediately after download — no restart needed.`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preferences',
      description: `Read, set, or list preferences for this group. Preferences are sandboxed — each group has its own. Two scopes: group defaults (apply to everyone) and user overrides (per-user values that take precedence).

Common preference keys:
• "translator_languages" — array of ISO 639-1 codes for voice message translation (e.g. ["es", "ko", "bg"])
• "response_language" — preferred response language for this group or user
• "verbose" — true/false, whether to show detailed status updates

Any key/value can be stored — preferences are a flexible key-value store. Use for any per-group or per-user configuration the user asks for.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'list'], description: 'What to do. "get" reads a key, "set" writes a key, "list" shows all preferences.' },
          key: { type: 'string', description: 'Preference key (required for get/set). Use snake_case.' },
          value: { description: 'Value to set (required for set). Can be string, number, boolean, or array. Pass null to delete.' },
          scope: { type: 'string', enum: ['group', 'user'], description: 'Default: group. "group" = applies to everyone. "user" = override for a specific user (requires user_id).' },
          user_id: { type: 'string', description: 'User ID for user-scoped preferences. Extract from the message sender field.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'perf_summary',
      description: 'View performance metrics for the current or a specific build version. Shows average response time, classify latency, model usage breakdown, think rate, and escalation count. Use to compare performance across versions and make data-driven optimization decisions.',
      parameters: {
        type: 'object',
        properties: {
          version: { type: 'string', description: 'Build ID to summarize (e.g. "0.1.50"). Omit for current version.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_service',
      description: `Start or restart a backend service. Use when a service is offline (detected via service_status) or when a generation tool fails because a backend is down. The service starts in the background on the host — check service_status after a few seconds to confirm it's up.

Services:
• "ollama" — text generation server (localhost:11434). If down, ALL LLM tasks fail.
• "searxng" — web search engine (localhost:8888). If down, web_search fails.
• "comfyui" — advanced image/video workflows (localhost:8000). If down, ComfyUI-backed generation fails; OllamaDiffuser is the fallback.
• "ollamadiffuser" — image/video generation API (localhost:8001). If down, diffuser-backed generation fails; ComfyUI is the fallback.

Use "start" to launch if not running (no-op if already running). Use "restart" to kill and relaunch (use after crashes or hangs).`,
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: ['ollama', 'searxng', 'comfyui', 'ollamadiffuser'], description: 'Which service to manage.' },
          action: { type: 'string', enum: ['start', 'restart'], description: 'Start (idempotent — no-op if running) or restart (kill then start). Default: start.' },
        },
        required: ['service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_status',
      description: `Check the health and availability of all local backend services. Returns 🟢 online or 🔴 offline for each. Use proactively before generation tasks, or when a tool call fails, to identify which service is down.

Services checked:
• Ollama (localhost:11434) — text generation, reasoning, vision, code. Required for all LLM tasks.
• ComfyUI (localhost:8000) — advanced image/video generation via node workflows. Provides highest quality FLUX image gen and LTX-Video video gen. Optional — OllamaDiffuser is the fallback.
• OllamaDiffuser (localhost:8001) — image/video generation via REST API. Handles FLUX, SD, PixArt, HunyuanVideo, LTX-Video. Primary fallback when ComfyUI is offline.
• SearXNG (localhost:8888) — privacy-first metasearch engine. Required for web_search tool. If offline, web search will fail.

If a service is offline: report it to the user. Do not guess or retry silently — tell them which service is down and what capabilities are affected.`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'comfyui_search_models',
      description: `Search the ComfyUI Manager model catalog (527+ curated models from HuggingFace and Civitai). Returns up to 15 matching models with name, type, base architecture, size, filename, save path, and download URL. Use this to find new models to install into ComfyUI.

Searchable fields: name, type, base architecture, and description. Combine query with type filter for precise results.

Common searches:
• "flux" — FLUX.1 checkpoints, UNETs, LoRAs, VAEs
• "sdxl" — Stable Diffusion XL models and LoRAs
• "video" or "ltx" — video generation checkpoints
• "upscale" — upscaling models (4x, ESRGAN, etc.)
• "controlnet" — ControlNet models for guided generation
• "inpaint" — inpainting models
• "lora" with type="lora" — style/concept LoRAs

After finding a model, use comfyui_install_model with the url, filename, and save_path from the results.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term. Matches against model name, type, base architecture, and description. Be specific: "flux lora" is better than just "model".' },
          type: { type: 'string', description: 'Optional filter by model type. Values: "checkpoint", "lora", "vae", "unet", "TAESD", "upscale_models", "clip", "clip_vision", "gligen", "hypernetwork", "photomaker", "insightface", "deepfashion", "face_restore", "sams", "mmdets", "annotators", "diffusers".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'comfyui_install_model',
      description: `Download and install a model into ComfyUI via the Manager's background queue. The download starts immediately and runs asynchronously — this call returns right away. Large models (multi-GB) may take several minutes to download. Check comfyui_list_models periodically to verify when the download completes. The model is usable immediately after download — no ComfyUI restart needed.

Always use values from comfyui_search_models results — do not construct URLs or paths manually. The Manager validates downloads against its catalog for security.`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Direct download URL from the comfyui_search_models results. Must be a HuggingFace or Civitai URL. Example: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors".' },
          filename: { type: 'string', description: 'Filename to save the model as, from comfyui_search_models results. Example: "sd_xl_base_1.0.safetensors". Must end in .safetensors for non-whitelisted models.' },
          save_path: { type: 'string', description: 'ComfyUI models subdirectory, from comfyui_search_models results. Common values: "checkpoints" (full models), "loras" (LoRA adapters), "vae" (VAE decoders), "unet" (FLUX UNETs), "clip" (text encoders), "upscale_models" (upscalers), "vae_approx" (preview decoders), "controlnet" (ControlNet models).' },
        },
        required: ['url', 'filename', 'save_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ollama_generate',
      description: `Call a local model for a subtask. Behaviour depends entirely on the model name:

IMAGE PATH — triggered when the model name contains "flux", "stable-diffusion", "sdxl", or "dall-e" (case-insensitive). Shorthand aliases resolve first: "flux" → "x/flux2-klein:9b", "vision"/"llama" → "qwen2.5vl:72b", "coder" → "qwen3-coder:30b", "artist" → "qwen2.5vl:72b". In image mode this call BLOCKS until the image is generated and sent to chat automatically. The parameters use_reference, embellish, and backend only apply in image mode — they are silently ignored for text models.

TEXT PATH — any other model name sends a conversational request to Ollama /api/chat and returns the text response. The system parameter only applies here.

SUB-AGENT PATTERNS — use ollama_generate for targeted delegation instead of always escalating the full conversation:
• Scoped subtask: keep orchestrating at your tier while delegating a specific sub-problem (e.g. call "coder" for just the code part while you handle the rest).
• Draft + critique: generate a first response, then call a higher tier to review or improve it before returning to the user.
• Parallel evaluation: call multiple models on the same question and synthesize their perspectives into one answer.
• Specialist consult: ask a higher model one targeted question ("what are the risks here?") rather than handing off the entire task.
These patterns keep you in control as orchestrator — use escalate only when the entire task exceeds your tier.`,
      parameters: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            description: 'Model name or alias. Built-in aliases: "flux" → "x/flux2-klein:9b" (image generation), "vision" or "llama" → "qwen2.5vl:72b" (vision model), "coder" → "qwen3-coder:30b" (code specialist), "artist" → "qwen2.5vl:72b" (visual advice — use generate_art/generate_film for actual generation), "secretary" → "qwen2.5:3b". Any model name containing "flux", "stable-diffusion", "sdxl", or "dall-e" activates the image generation path; all other names use text chat. You can also use any model name from ollama_list_models directly.',
          },
          prompt: {
            type: 'string',
            description: 'For text models: the user message sent to the model. For image models: the base generation prompt. Note — in image mode this prompt may be significantly rewritten before submission: if reference images exist they are described by a vision model and prepended ("Character 1: [desc]. Modification: [your prompt]"), then if embellish=true (the default) the combined prompt is further expanded by a prompt-engineer LLM. The caption shown to the user always uses your original prompt, not the rewritten version.',
          },
          system: {
            type: 'string',
            description: 'Optional system prompt prepended before the user message. TEXT MODELS ONLY — ignored entirely for image models.',
          },
          use_reference: {
            type: 'boolean',
            description: 'IMAGE MODELS ONLY. Default: true. When true, loads saved reference images from the most recent photo the user sent (expires after 10 minutes). If multiple images were saved, ALL are described by qwen2.5vl:72b and prepended to the prompt as character descriptions; only the first image is passed as the actual i2i input to OllamaDiffuser/Ollama. Note: ComfyUI image backend does NOT support i2i — if a reference image exists and backend=auto, ComfyUI is skipped and OllamaDiffuser is tried first. Set to false to generate from text only with no reference context.',
          },
          embellish: {
            type: 'boolean',
            description: 'IMAGE MODELS ONLY. Default: true. When true, the prompt (after any reference image descriptions are prepended) is sent to qwen2.5vl:72b acting as a creative director, which expands it with subject details, lighting, mood, style, and quality modifiers. The expanded version is used for generation. Set to false to submit the prompt exactly as written — use this when the user has already written a detailed prompt or says "exact prompt" / "as-is" / "no embellish".',
          },
          backend: {
            type: 'string',
            enum: ['auto', 'comfyui', 'ollamadiffuser', 'ollama'],
            description: 'IMAGE MODELS ONLY. Default: auto. Controls which image generation service is used. auto: tries ComfyUI first (text-to-image only — skipped automatically if a reference image is loaded), then OllamaDiffuser, then Ollama as final fallback. comfyui: ComfyUI only — requires z_image_turbo_bf16.safetensors UNET + clip_l.safetensors + t5xxl_fp16.safetensors + ae.safetensors VAE installed; throws immediately if unavailable or missing. ollamadiffuser: OllamaDiffuser only — picks the best available model by preference (flux.2-klein-4b > flux.1-dev > sdxl-turbo > pixart-sigma > stable-diffusion-3); throws if unavailable or no model found. ollama: calls Ollama /api/generate directly with the model parameter as the model name; useful as an explicit fallback. Named backends throw immediately on failure — use auto to fall through to the next option.',
          },
        },
        required: ['model', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description: 'Generate a video from a text prompt. This call BLOCKS — it polls until the video is fully generated, then sends it to chat automatically and returns a result string. You do not need to poll, check status, or ask the user to monitor anything. Generation typically takes 1–5 minutes.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Description of the video to generate. Submitted as-is — write a detailed cinematic prompt directly. When multiple reference images are loaded and backend is ComfyUI, images at index 2+ are described by qwen2.5vl:72b and automatically prepended to your prompt as context; you do not need to describe them yourself.',
          },
          backend: {
            type: 'string',
            enum: ['auto', 'comfyui', 'ollamadiffuser'],
            description: 'Which video backend to use. Default: auto (tries ComfyUI first, then OllamaDiffuser). auto: falls through silently to OllamaDiffuser if ComfyUI fails or its checkpoint is missing. comfyui: ComfyUI only — requires ltx-video-2b-v0.9.5.safetensors in ComfyUI/models/checkpoints/; throws immediately if unavailable or checkpoint missing. ollamadiffuser: OllamaDiffuser only — requires a model with "video", "animate", "wan", "ltx", "cogvideo", or "motion" in its name; throws immediately if unavailable or no video model found. Named backends throw on failure rather than falling through.',
          },
          use_reference: {
            type: 'boolean',
            description: 'Default: true. Controls whether saved context is used as a start frame or generation seed. When true, context is loaded in this priority order: (1) saved reference images from .latest-image.json — expires after 10 minutes; (2) if no images, first frame extracted from .latest-video.mp4 via ffmpeg — also expires after 10 minutes. For ComfyUI: the first image/frame buffer is used as the I2V (image-to-video) start frame; additional images (index 2+) are described by qwen2.5vl:72b and prepended to the prompt. For OllamaDiffuser: the first image is passed as the "image" field; the backend decides how to use it. If use_reference=true but no saved context exists (expired or never sent), generation silently falls back to text-to-video with no error. Set to false for pure text-to-video with no reference context.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_art',
      description: 'Consult the Artist (qwen2.5vl:72b) to craft an expert image generation prompt. Returns the Artist\'s interpretation and recommended settings — share this with the user for confirmation before generating. After approval, call ollama_generate with the Artist\'s prompt and embellish=false to execute. This two-step flow saves processing time by catching misunderstandings before the expensive generation step.',
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: 'The art request in natural language. Describe subject, style, mood, references, or intent. The Artist translates this into an expert generation prompt and handles everything else.',
          },
        },
        required: ['request'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_film',
      description: 'Consult the Cinematographer (qwen2.5vl:72b) to craft an expert cinematic prompt. Returns the Cinematographer\'s interpretation and recommended settings — share this with the user for confirmation before generating. After approval, call generate_video with the Cinematographer\'s prompt to execute. This two-step flow saves minutes by catching misunderstandings before the expensive video generation step.',
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: 'The film request in natural language. Describe the scene, motion, mood, style, and pacing. The Cinematographer translates this into a high-quality cinematic prompt and handles everything else.',
          },
        },
        required: ['request'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_status',
      description: 'Update the thinking indicator shown to the user while you work. The text is automatically wrapped in Telegram italic formatting — do not add markdown yourself. It appears appended to a base label showing the model name and task, not as a standalone message. This tool always returns an empty string — it produces no conversation result and does not consume a tool-call round. Call it to narrate non-trivial steps: "Analyzing the request...", "Checking reference images...", "Enhancing prompt...". Special trigger: if the text contains "generating image" or "generating video" (case-insensitive), the spinner label changes from "Thinking"/"Lagging" to "Processing".',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Status text to display. Keep under 60 characters. Do not add italic/bold markdown — it is applied automatically. Write as a present-participle phrase, e.g. "Checking available models..." or "Uploading reference image...".',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restart_self',
      description: 'Wipe conversation history and restart the process. Deletes the saved history file so the next session starts with no memory of this conversation. The process exits and the host restarts it fresh. Use when explicitly asked to restart, when you are stuck in a bad state, or to recover from repeated errors.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_help',
      description: 'Return a comprehensive formatted list of all available features, tools, and capabilities with usage examples. Call when the user asks what you can do, how to use a feature, says "help", or seems unsure about your capabilities. The help text includes: chat, web search, image generation, video generation, vision, scheduling, model management, service health, and self-management.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate',
      description: `Hand off to the next reasoning tier when the current task exceeds your capability.

Escalation ladder (in order):
1. qwen3.5:35b — you (orchestrator, first responder, fast generalist)
2. qwen3.5:35b + thinking mode — same model, deeper reasoning enabled
3. deepseek-r1:70b — principal architect: maximum capability, final escalation

Exception: qwen3-coder:30b (coding specialist) escalates to qwen3.5:35b + thinking mode.

Think of this like picking up the phone to call the right expert on your team. You are not failing — you are making a good judgment call. A senior architect who immediately routes a hard problem to the right specialist is more effective than one who struggles alone. Each escalation passes full conversation context so the specialist picks up exactly where you left off. The reason parameter is for logging only. At maximum tier (deepseek-r1:70b), escalation is a no-op.`,
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Brief explanation of why this task needs a more capable tier. Used for logging only — does not affect routing.',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_changelog',
      description: "Retrieve release notes from the changelog. Call when the user asks what's new, what changed, about a specific version, for release notes, or what version is running. The changelog is auto-generated from git commits on each build. Each entry includes the version number, date, title (first commit message), and all commit messages since the previous version.",
      parameters: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
            description: 'Omit to get the highest version number in the changelog (note: this may differ from the currently running build ID if the changelog has future entries). Exact match: pass a version string like "0.0.45". Range: pass two versions separated by a hyphen like "0.0.40-0.0.45" — both ends are inclusive, matched numerically by semver. If the specified version does not exist in the changelog, an error string is returned.',
          },
          all: {
            type: 'boolean',
            description: 'Set true to return all versions in descending order. May produce a long response.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: `Search the live web via local SearXNG metasearch engine (privacy-first — no external tracking). Returns numbered results with title, URL, and content snippet. Use for: current events, facts you are unsure about, finding documentation, looking up Ollama models at ollama.com/library, technical references, or anything that needs live information. Do not guess or use training data for time-sensitive questions — search first.

Requires SearXNG to be running (check service_status if this fails). Results come from Google, Bing, DuckDuckGo, and other engines aggregated by SearXNG. For reading a specific page from the results, follow up with fetch_url.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Use specific keywords for best results (e.g. "qwen3 32b ollama benchmark" not "what is the best model"). Include site: prefix to search specific sites (e.g. "site:ollama.com gemma3").',
          },
          max_results: {
            type: 'number',
            description: 'Number of results to return. Default: 5. Maximum: 10. More results = more context but longer response.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: `Fetch a URL and return its content as clean, readable markdown text. Uses Jina Reader (r.jina.ai) for high-quality HTML-to-markdown conversion; falls back to direct fetch with basic HTML stripping if Jina is unavailable. Content is truncated to ~6000 characters.

Use cases: reading articles, documentation pages, GitHub READMEs, Ollama model pages, HuggingFace model cards, blog posts, or any web page from web_search results. For searching (not reading a specific URL), use web_search first.`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full URL including protocol. Must start with http:// or https://. Examples: "https://ollama.com/library/gemma3", "https://huggingface.co/black-forest-labs/FLUX.1-dev".',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: `Create, cancel, pause, resume, or list scheduled tasks. Tasks run as new conversations in this chat at the scheduled time.

Schedule types:
• once: runs once at a specific time. schedule_value = ISO 8601 timestamp (e.g. "2026-03-20T09:00:00Z")
• interval: repeats every N milliseconds. schedule_value = ms as string (e.g. "3600000" for every hour)
• cron: standard cron expression. schedule_value = cron string (e.g. "0 9 * * 1-5" for weekdays at 9am)

context_mode:
• "group" (default): task runs with access to this conversation's history — useful for follow-ups and ongoing work
• "isolated": fresh session, no conversation history — useful for independent recurring checks`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'cancel', 'pause', 'resume', 'list'],
            description: 'What to do. "list" returns all active tasks for this chat.',
          },
          prompt: {
            type: 'string',
            description: 'The task prompt — what to do when the task runs. Required for create.',
          },
          schedule_type: {
            type: 'string',
            enum: ['once', 'interval', 'cron'],
            description: 'How to schedule the task. Required for create.',
          },
          schedule_value: {
            type: 'string',
            description: 'Schedule value matching the schedule_type. Required for create.',
          },
          task_id: {
            type: 'string',
            description: 'Task ID to cancel, pause, or resume. Required for those actions. Use "list" to find IDs.',
          },
          context_mode: {
            type: 'string',
            enum: ['group', 'isolated'],
            description: 'Conversation context for the task (default: "group").',
          },
        },
        required: ['action'],
      },
    },
  },
];

// run_command is intentionally NOT in OLLAMA_TOOLS — offering it as a structured tool causes
// llama3.2 to call it proactively (e.g. `git status` before every response). It is still
// available via text-encoded tool calls (parseTextToolCall) for explicit user requests.

// Container mount paths — all workspace paths in one place
const WORKSPACE_GROUP    = '/workspace/group';
const WORKSPACE_IPC      = '/workspace/ipc';
const WORKSPACE_PROJECT  = '/workspace/extra/nanoclaw';            // host project root (read-only)
const WORKSPACE_GITCFG   = '/workspace/extra/gitconfig';           // host ~/.gitconfig (read-only)
const CONTAINER_HOME     = '/home/node';
const CONTAINER_APP      = '/app/ollama-runner';                   // built ollama-runner assets

const IPC_DIR               = WORKSPACE_IPC;
const IPC_MSG_DIR           = path.join(WORKSPACE_IPC, 'messages');
const IPC_TASKS_DIR         = path.join(WORKSPACE_IPC, 'tasks');
const IPC_CURRENT_TASKS     = path.join(WORKSPACE_IPC, 'current_tasks.json');
const IPC_INPUT_DIR         = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const HISTORY_FILE          = path.join(WORKSPACE_GROUP, '.ollama-history.json');
const SECRETARY_FEEDBACK_FILE = path.join(WORKSPACE_GROUP, '.secretary-feedback.json');
const LATEST_IMAGE_FILE     = path.join(WORKSPACE_GROUP, '.latest-image.json');
const PREFERENCES_FILE      = path.join(WORKSPACE_GROUP, '.preferences.json');

// ---------------------------------------------------------------------------
// Preferences — sandboxed per group workspace, two scopes:
//   group defaults: apply to everyone
//   user overrides: per-user values that take precedence over group defaults
//
// Storage: { group: { key: value }, users: { "<userId>": { key: value } } }
// Lookup: user override > group default
// ---------------------------------------------------------------------------

interface PreferencesStore {
  group: Record<string, unknown>;
  users: Record<string, Record<string, unknown>>;
}

function loadPreferences(): PreferencesStore {
  try {
    if (fs.existsSync(PREFERENCES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf-8'));
      return { group: raw.group ?? {}, users: raw.users ?? {} };
    }
  } catch { /* ignore */ }
  return { group: {}, users: {} };
}

function savePreferences(prefs: PreferencesStore): void {
  fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
}

function getPref(key: string, userId?: string): unknown {
  const prefs = loadPreferences();
  if (userId && prefs.users[userId]?.[key] !== undefined) {
    return prefs.users[userId][key];
  }
  return prefs.group[key];
}

function setGroupPref(key: string, value: unknown): void {
  const prefs = loadPreferences();
  if (value === null || value === undefined) delete prefs.group[key];
  else prefs.group[key] = value;
  savePreferences(prefs);
}

function setUserPref(userId: string, key: string, value: unknown): void {
  const prefs = loadPreferences();
  if (!prefs.users[userId]) prefs.users[userId] = {};
  if (value === null || value === undefined) delete prefs.users[userId][key];
  else prefs.users[userId][key] = value;
  savePreferences(prefs);
}
const BUILD_ID_FILE         = path.join(CONTAINER_APP, 'build-id.txt');
const CHANGELOG_FILE        = path.join(CONTAINER_APP, 'changelog.json');

const buildId = (() => {
  try { return fs.readFileSync(BUILD_ID_FILE, 'utf-8').trim(); } catch { return '??????'; }
})();

// Version gate: if the host passed an expected build ID and it doesn't match
// our compiled-in version, exit immediately. The host will spawn a fresh container.
const expectedBuildId = process.env.EXPECTED_BUILD_ID;
if (expectedBuildId && expectedBuildId !== buildId) {
  process.stderr.write(`[nanoclaw] Version mismatch: running v${buildId}, expected v${expectedBuildId} — exiting\n`);
  process.exit(1);
}

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';

// ---------------------------------------------------------------------------
// Model registry — all model names in one place.
// Override coordinator/secretary via env vars to switch without a code change.
// ---------------------------------------------------------------------------
export const MODELS = {
  // Always-on (pinned in VRAM)
  COORDINATOR:  process.env.OLLAMA_MODEL_COORDINATOR  || 'qwen3.5:35b',
  SECRETARY:    process.env.OLLAMA_MODEL_SECRETARY     || 'qwen2.5:3b',

  // Specialists (evict after idle)
  CODER:        process.env.OLLAMA_MODEL_CODER         || 'qwen3-coder:30b',
  ARCHITECT:    process.env.OLLAMA_MODEL_ARCHITECT     || 'deepseek-r1:70b',
  VISION:       process.env.OLLAMA_MODEL_VISION        || 'qwen2.5vl:72b',
  IMAGE:        process.env.OLLAMA_MODEL_IMAGE         || 'x/flux2-klein:9b',
} as const;

// Set of models that support tool-calling (vision models do not)
const MODELS_WITHOUT_TOOLS = new Set([MODELS.VISION]);

// Only coordinator supports think: true — secretary is classification-only
const MODELS_WITH_THINK = new Set([MODELS.COORDINATOR]);

// Models that stay pinned in VRAM (keep_alive: KEEP_ALIVE_PINNED)
const MODELS_PINNED = new Set([MODELS.COORDINATOR, MODELS.SECRETARY]);
// Specialists evict immediately after use — frees VRAM for larger models
const KEEP_ALIVE_PINNED = -1;      // never evict — stays in VRAM permanently
const KEEP_ALIVE_SPECIALIST = '0'; // evict immediately — frees VRAM for other models
const TOOL_TIMEOUT_MS = 600_000;       // 10 min — deepseek-r1 with thinking can run 2-5 min
const IMAGE_TOOL_TIMEOUT_MS = 120_000; // 2 min for image generation
const VIDEO_TOOL_TIMEOUT_MS = 360_000; // 6 min for video generation (internal deadline is 5 min)
const WEB_TOOL_TIMEOUT_MS = 20_000;    // 20 s for web requests
const HISTORY_MAX_MSG_CHARS = 0;    // 0 = no truncation (local — no token cost)
const HISTORY_MAX_MESSAGES = 30;    // tight cap — prevents slow responses; user can ask for context
// Default history config — fast tier (35b no-think)
const HISTORY_COMPRESS_THRESHOLD = 12; // compress early and often
const HISTORY_KEEP_RECENT = 6;         // keep last 6 verbatim; compress the rest
// Extended history config — thinking, reasoning, and coding tiers
const HISTORY_COMPRESS_THRESHOLD_EXT = 20; // compress when >20 messages
const HISTORY_KEEP_RECENT_EXT = 10;        // keep last 10 verbatim
// Hard safety limits for what gets sent to Ollama (prevents inference hangs)
const INFERENCE_MAX_MESSAGES = 20;     // tight — fast responses over deep context
const INFERENCE_MAX_CHARS = 24_000;    // ~6K tokens — keeps inference fast
const MSG_CONTENT_MAX_CHARS = 2_000;   // truncate tool outputs and long messages
const SECRETARY_FEEDBACK_MAX = 50; // rolling store; only non-correct grades kept
const IPC_POLL_MS = 100;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Triggers automatic escalation to the next tier when a model signals failure:
//   - explicit apologies: "I apologize", "my apologies", "I'm sorry, I..."
//   - task failure:       "I wasn't able to", "I couldn't complete", "I failed to"
//   - stuck/confused:     "I don't know how to fix/resolve this", "I'm stuck", "I'm not sure how to proceed"
// Does NOT trigger on empathy phrases like "I'm sorry to hear that" or capability disclaimers.
const AUTO_ESCALATE_PATTERN = /\bI apologize\b|\bmy apologies\b|(?:I'?m|I am) sorry[,.!]\s|(?:I'?m|I am) sorry,?\s+(?:but |I |for the (?:confusion|error|mistake)|\bsorry about that\b)|I (?:wasn'?t|was not) able to\b|(?:I'?m|I am) unable to\b|I couldn'?t (?:complete|solve|figure|finish|handle|do)\b|I don'?t know how to (?:fix|resolve|correct|handle|address)\b|(?:I'?m|I am) (?:stuck|not sure how to proceed)\b|I failed to\b/im;

// Routes to qwen3-coder:30b when the message requires code as input or output:
//   — contains inline code or a code block (backticks)
//   — unambiguous coding verbs: implement, refactor, debug
//   — action verb + code artifact noun (function, class, script, API, SQL, regex, etc.)
const CODING_PATTERN = /`[^`\n]+`|```|\b(?:implement|refactor|debug)\b|\b\w+\.[jt]sx?|\.py|\.go|\.rs|\.rb|\.sh\b|\b(?:write|create|generate|build|fix|add|update|edit|change|run|execute|test|read|look at|review|check|inspect|examine|find|open|show)\s+(?:(?:a|an|the|my|some|this|your|that)\s+)?(?:function|class|method|script|module|component|endpoint|api\b|sql\b|query|regex|regexp|algorithm|program\b|snippet|codebase|test(?:s)?|spec(?:s)?|cli\b|source|file|repo|repository|package|library|import|dependency|config|dockerfile|workflow)/im;
const CREATIVE_PATTERN = /(?:write|tell|create|compose|craft|generate|draw|paint|sketch|design|make)\s+(?:(?:a|an|me|us)\s+)?(?:story|poem|song|script|narrative|fiction|tale|essay|joke|haiku|limerick|creative|picture|image|photo|illustration|art|painting|portrait|video|film|animation|clip)/im;
const BRAINSTORM_PATTERN = /(?:brainstorm|ideas? for|suggest(?:ions)?|what if|alternatives?|possibilities|ways to|how (?:could|might|would|can)(?: (?:i|we))?|how can\b|give me \d+ |list \d+ )/im;
const ANALYSIS_PATTERN = /(?:analyz|explain|summariz|describ|compar|what (?:is|are|does|do)|how does|why (?:is|does|do)|tell me about|define|difference between)/im;

// Explicit escalation — user wants the heaviest model (deepseek-r1:70b)
const ESCALATE_PATTERN = /\b(?:escalate|use (?:deepseek|reasoning model|architect|biggest model)|think (?:much )?harder|really think|maximum (?:reasoning|thinking|effort))\b/im;

// Explicit user requests for deeper reasoning (think=true on coordinator)
// Tightened to avoid false positives on casual words like "sure", "try", "learn"
const THINK_PATTERN = /(?:think (?:hard(?:er)?|carefully|deeper|step.by.step|it through|about (?:this|it))|think(?:ing)? mode|reason(?:ing)? (?:through|mode)|show (?:all |your |me )?(?:thinking|reasoning|thoughts?)|slow(?:ly)? (?:think|reason)|be (?:thorough|careful|precise)|use (?:your )?(?:full )?(?:thinking|reasoning)|(?:complex|difficult|hard|tricky|multi.step) (?:problem|question|task)|(?:math|logic|proof|calcul|deriv|solv(?:e|ing))|step.by.step|work(?:ing)? (?:this )?out)/im;

// Hard decisions only — casual recommendations and "which is better?" don't warrant thinking overhead
const DECISION_PATTERN = /\bshould (?:i|we)\b|help me (?:decide|choose|figure out)\b|pros? and cons?\b|trade.?offs?\b/im;

// Regex fallbacks — used when Secretary classification times out or fails
export function shouldThinkFallback(text: string): boolean {
  return THINK_PATTERN.test(text) || DECISION_PATTERN.test(text);
}

export function shouldEscalateFallback(text: string): boolean {
  return ESCALATE_PATTERN.test(text);
}

export function selectModelFallback(text: string, hasImages?: boolean): string {
  if (hasImages) return MODELS.VISION;
  if (ESCALATE_PATTERN.test(text)) return MODELS.ARCHITECT;
  if (CODING_PATTERN.test(text)) return MODELS.CODER;
  return MODELS.COORDINATOR;
}

export type TaskType = 'code' | 'creative' | 'brainstorm' | 'analysis';
export type RichTaskType = 'chat' | 'code' | 'creative' | 'analysis' | 'decision' | 'debug' | 'research';

const DEBUG_PATTERN = /\b(?:debug|error|bug|crash|exception|traceback|stack\s*trace|undefined is not|cannot read|segfault|ENOENT|EACCES|panic|fatal)\b/im;
const RESEARCH_PATTERN = /\b(?:search|look\s*up|find\s+(?:me|out)|google|research|what\s+(?:is|are)\s+the\s+(?:latest|current|best))\b/im;

export function detectTaskType(text: string): TaskType {
  if (CODING_PATTERN.test(text)) return 'code';
  if (CREATIVE_PATTERN.test(text)) return 'creative';
  if (BRAINSTORM_PATTERN.test(text)) return 'brainstorm';
  if (ANALYSIS_PATTERN.test(text)) return 'analysis';
  return 'analysis';
}

export function detectRichTaskType(text: string): RichTaskType {
  if (DEBUG_PATTERN.test(text)) return 'debug';
  if (CODING_PATTERN.test(text)) return 'code';
  if (CREATIVE_PATTERN.test(text)) return 'creative';
  if (RESEARCH_PATTERN.test(text) || detectNeedsWeb(text)) return 'research';
  if (DECISION_PATTERN.test(text)) return 'decision';
  if (BRAINSTORM_PATTERN.test(text)) return 'analysis';
  return 'chat';
}

const TASK_TEMPERATURE: Record<RichTaskType, number> = {
  chat: 0.3,
  code: 0.2,
  debug: 0.2,
  analysis: 0.3,
  decision: 0.3,
  research: 0.4,
  creative: 0.9,
};

export function getTemperature(text: string): number {
  return TASK_TEMPERATURE[detectTaskType(text) as RichTaskType] ?? 0.3;
}

// Detect whether a message needs live web data (no LLM, keyword-only)
const WEB_PATTERN = /\b(?:today|tonight|yesterday|this (?:week|month|year)|current(?:ly)?|latest|recent(?:ly)?|(?:right )?now|live|real.?time|breaking|price of|weather|stock|score|news|update on|what(?:'s| is) happening|who (?:won|is winning))\b/im;

// Detect user dissatisfaction — signals that the previous response was wrong or insufficient.
// When detected, the coordinator should retry at a higher tier or change approach.
const DISSATISFACTION_PATTERN = /\b(?:no[,.]?\s+(?:that'?s|it'?s|this is)\s+(?:not|wrong)|(?:try|do)\s+(?:again|harder|better)|not (?:right|correct|what I (?:asked|meant|wanted))|you(?:'re| are) wrong|that(?:'s| is) (?:wrong|incorrect|not it)|escalate|can you (?:actually|really)|I said|re-?do|redo this|start over|try a different)\b/im;
export function detectDissatisfaction(text: string): boolean {
  return DISSATISFACTION_PATTERN.test(text);
}
export function detectNeedsWeb(text: string): boolean {
  return WEB_PATTERN.test(text);
}

// Estimate complexity from message structure (no LLM)
export function estimateComplexity(text: string): 'low' | 'medium' | 'high' {
  const words = text.trim().split(/\s+/).length;
  const hasMultipleQuestions = (text.match(/\?/g) || []).length > 1;
  const hasCodeBlock = /```/.test(text);
  const hasListOrSteps = /(?:^\s*[-•\d]\.?\s)/m.test(text);

  if (words < 8 && !hasMultipleQuestions && !hasCodeBlock) return 'low';
  if (words > 100 || hasMultipleQuestions || hasCodeBlock || hasListOrSteps) return 'high';
  return 'medium';
}

// Build a routing hint string for the coordinator's context
export function buildRouteHint(text: string, hasImages: boolean): string {
  const taskType = detectTaskType(text);
  const complexity = estimateComplexity(text);
  const needsWeb = detectNeedsWeb(text);
  const think = shouldThinkFallback(text);
  const parts: string[] = [];

  if (taskType === 'code') parts.push('code task — consider delegating to coder for implementation');
  else if (taskType === 'creative') parts.push('creative task');
  else if (taskType === 'brainstorm') parts.push('brainstorm');
  else parts.push('general');

  parts.push(complexity);

  if (needsWeb) parts.push('needs live data — call web_search before answering');
  if (think) parts.push('complex reasoning — consider thinking mode or analyst tier');
  if (hasImages) parts.push('images attached — vision task');
  if (detectDissatisfaction(text)) parts.push('USER DISSATISFIED with previous response — escalate to a higher tier or change approach entirely');
  if (shouldEscalateFallback(text)) parts.push('USER REQUESTS ESCALATION — use the escalate tool to route to deepseek-r1:70b immediately');

  return `[Route: ${parts.join(' · ')}]`;
}

export interface MessageClassification {
  model: string;
  think: boolean;
  taskType: TaskType;
  taskTypeRich: RichTaskType;
  temperature: number;
  complexity: 'low' | 'medium' | 'high';
  usedSecretary: boolean;  // true = actual qwen2.5:3b call succeeded; false = image shortcut or regex fallback
  needsWeb?: boolean;      // true when question requires live/current data; secretary skips draft, coordinator primed to web_search
}

export { TASK_TEMPERATURE };

export interface SecretaryGrade {
  at: number;
  promptPreview: string;
  routingGrade: 'correct' | 'suboptimal' | 'wrong';
  routingNote?: string;
}

function loadSecretaryFeedback(): SecretaryGrade[] {
  try {
    if (fs.existsSync(SECRETARY_FEEDBACK_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETARY_FEEDBACK_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function appendSecretaryFeedback(grade: SecretaryGrade): void {
  try {
    const existing = loadSecretaryFeedback();
    const trimmed = [...existing, grade].slice(-SECRETARY_FEEDBACK_MAX);
    fs.writeFileSync(SECRETARY_FEEDBACK_FILE, JSON.stringify(trimmed, null, 2));
  } catch { /* ignore */ }
}

/** Format recent non-trivial grades as a calibration hint for the secretary's classify prompt. */
function formatFeedbackForPrompt(grades: SecretaryGrade[]): string {
  const actionable = grades
    .filter((g) => g.routingGrade !== 'correct')
    .slice(-5);
  if (actionable.length === 0) return '';
  const lines = actionable
    .filter((g) => g.routingNote)
    .map((g) => `"${g.promptPreview}" → ${g.routingNote}`);
  return lines.length > 0 ? `\nRecent corrections — self-calibrate:\n${lines.map((l) => `• ${l}`).join('\n')}\n` : '';
}

/** Classify a message using the Secretary (qwen2.5:3b) for semantic routing.
 * For low-complexity messages the secretary also drafts an answer — the coordinator
 * reviews it and either echoes it or steps in with their own response.
 * Falls back to regex classifiers if the call fails or times out. */
// Force-routing tags: (TagName) anywhere in the message overrides classification.
// Can be used mid-conversation to escalate or redirect a running task.
const FORCE_ROUTE_TAGS: Array<{ pattern: RegExp; model: string; think: boolean; label: string }> = [
  { pattern: /\(secretary\)/i,  model: MODELS.SECRETARY,   think: false, label: 'secretary' },
  { pattern: /\(jarvis\)/i,     model: MODELS.COORDINATOR, think: false, label: 'coordinator' },
  { pattern: /\(coder\)/i,      model: MODELS.CODER,       think: false, label: 'coder' },
  { pattern: /\(think\)/i,      model: MODELS.COORDINATOR, think: true,  label: 'think' },
  { pattern: /\(artist\)/i,     model: MODELS.VISION,      think: false, label: 'artist' },
  { pattern: /\(deep\)/i,       model: MODELS.ARCHITECT,   think: true,  label: 'architect' },
  { pattern: /\(vision\)/i,     model: MODELS.VISION,      think: false, label: 'vision' },
  { pattern: /\(art\)/i,        model: MODELS.VISION,      think: false, label: 'artist' },
  { pattern: /\(fast\)/i,       model: MODELS.SECRETARY,   think: false, label: 'fast' },
];

export async function classifyMessage(text: string, hasImages: boolean): Promise<MessageClassification> {
  // Force-routing tags override all classification
  for (const tag of FORCE_ROUTE_TAGS) {
    if (tag.pattern.test(text)) {
      log(`[classify] force-routed via (${tag.label}) tag`);
      return {
        model: tag.model,
        think: tag.think,
        taskType: tag.model === MODELS.CODER ? 'code' : tag.model === MODELS.VISION ? 'creative' : 'analysis',
        taskTypeRich: tag.model === MODELS.CODER ? 'code' : tag.model === MODELS.VISION ? 'creative' : 'analysis',
        temperature: 0.3,
        complexity: tag.think ? 'high' : 'medium',
        needsWeb: false,
        usedSecretary: false,
      };
    }
  }

  // Images always route to the vision model regardless of content
  if (hasImages) {
    return { model: MODELS.VISION, think: false, taskType: 'analysis', taskTypeRich: 'analysis', temperature: 0.3, complexity: 'low', usedSecretary: false };
  }

  // Fast keyword classification — zero inference, sub-millisecond.
  // Detects task type, complexity, needs_web, and think mode from keywords.
  // The coordinator gets a route hint injected into context to act on.
  if (process.env.DISABLE_SECRETARY === '1') {
    const classifyStart = Date.now();
    const escalate = shouldEscalateFallback(text);
    const model = selectModelFallback(text);
    const think = shouldThinkFallback(text) || escalate;
    const taskType = detectTaskType(text);
    const taskTypeRich = detectRichTaskType(text);
    const complexity = escalate ? 'high' as const : estimateComplexity(text);
    const needsWeb = detectNeedsWeb(text);
    const dissatisfied = detectDissatisfaction(text);
    logPerf({ type: 'classify', buildId, timestamp: new Date().toISOString(), classifyMs: Date.now() - classifyStart, classifyMethod: 'keyword' });
    if (escalate) logPerf({ type: 'escalation', buildId, timestamp: new Date().toISOString(), reason: 'user_escalation' });
    if (dissatisfied) logPerf({ type: 'escalation', buildId, timestamp: new Date().toISOString(), reason: 'user_dissatisfaction' });
    return { model, think: think || dissatisfied, taskType, taskTypeRich, temperature: getTemperature(text), complexity: dissatisfied ? 'high' : complexity, needsWeb, usedSecretary: false };
  }

  // LLM-based classification (when secretary is enabled)
  const feedbackHint = formatFeedbackForPrompt(loadSecretaryFeedback());
  const classifyPrompt = `Classify this message. Identify the ACTION VERB and RECIPIENT to determine intent.${feedbackHint}
Return JSON only, no explanation:
{"model":"default|coder|analyst|architect|artist","think":true|false,"complexity":"low|medium|high","task_type":"chat|code|creative|analysis|decision|debug|research","needs_web":true|false}

Rules:
- model: choose based on the PRIMARY ACTION VERB, not modal verbs (can/could/would)
  - "default" — general chat, greetings, questions, opinions, casual conversation
  - "coder" — ONLY when the action verb is code-specific: write/debug/refactor/implement/deploy code
  - "analyst" — complex reasoning, trade-offs, multi-step analysis
  - "architect" — hardest problems requiring deep expertise
  - "artist" — image/video generation (draw, paint, generate image/video)
- think: true only for multi-step reasoning, trade-offs, or complex analysis
- needs_web: true only for live/current data (news, prices, weather, recent events)
- When in doubt, use "default" — it can delegate to specialists itself

Message: ${JSON.stringify(text.slice(0, 400))}`;

  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODELS.SECRETARY,
        messages: [{ role: 'user', content: classifyPrompt }],
        keep_alive: KEEP_ALIVE_PINNED,
        options: { num_ctx: 1024, temperature: 0.1 },
        stream: false,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`classify: ${resp.status}`);
    const data = await resp.json() as OllamaResponse;
    const raw = extractContent(data.message.content).trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const c = JSON.parse(raw) as { model: string; think: boolean; complexity: string; task_type: string; needs_web?: boolean };

    const MODEL_MAP: Record<string, string> = {
      default:   MODELS.COORDINATOR,
      coder:     MODELS.CODER,
      analyst:   MODELS.COORDINATOR,
      architect: MODELS.ARCHITECT,
      artist:    MODELS.COORDINATOR,
    };
    const model = MODEL_MAP[c.model] ?? MODELS.COORDINATOR;

    let think = !!c.think || c.model === 'analyst';
    if (c.complexity === 'high' && (c.model === 'default' || !c.model)) {
      think = true;
    }

    const RICH_TYPES: RichTaskType[] = ['chat', 'code', 'creative', 'analysis', 'decision', 'debug', 'research'];
    const taskTypeRich: RichTaskType = RICH_TYPES.includes(c.task_type as RichTaskType)
      ? (c.task_type as RichTaskType) : 'analysis';

    const TASK_TYPE_MAP: Record<RichTaskType, TaskType> = {
      chat: 'analysis', code: 'code', creative: 'creative',
      analysis: 'analysis', decision: 'analysis', debug: 'code', research: 'analysis',
    };
    const taskType = TASK_TYPE_MAP[taskTypeRich];
    const temperature = TASK_TEMPERATURE[taskTypeRich] ?? 0.3;
    const complexity = (['low', 'medium', 'high'].includes(c.complexity) ? c.complexity : 'medium') as MessageClassification['complexity'];
    const needsWeb = !!c.needs_web;

    log(`[classify] ${c.model}→${model} think=${think} complexity=${complexity} task=${taskTypeRich}${needsWeb ? ' [needs_web]' : ''}`);
    return { model, think, taskType, taskTypeRich, temperature, complexity, needsWeb, usedSecretary: true };
  } catch (err) {
    log(`[classify] fallback to regex: ${err instanceof Error ? err.message : String(err)}`);
    const escalate = shouldEscalateFallback(text);
    const model = selectModelFallback(text);
    const think = shouldThinkFallback(text) || escalate;
    const taskType = detectTaskType(text);
    const taskTypeRich = detectRichTaskType(text);
    const complexity = escalate ? 'high' as const : estimateComplexity(text);
    const needsWeb = detectNeedsWeb(text);
    return { model, think, taskType, taskTypeRich, temperature: getTemperature(text), complexity, needsWeb, usedSecretary: false };
  }
}

/** Returns the "Working..." status label appropriate for a given model/think state. */
function getStatusLabel(model: string, think: boolean): string {
  if (model === MODELS.ARCHITECT) return 'Reasoning';
  if (think) return 'Thinking';
  if (model === MODELS.CODER) return 'Working';
  return 'Responding';
}


// Secretary provides classification only. Routing corrections still accumulate in
// SECRETARY_FEEDBACK_FILE and are injected into the classify prompt for self-calibration.

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[ollama-runner] ${message}`);
}


function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const messages = drainIpcInput();
      if (messages.length > 0) { resolve(messages.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function loadHistory(): Message[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistory(history: Message[]): void {
  try {
    // No truncation — local models have no token cost
    const trimmed = history.slice(-HISTORY_MAX_MESSAGES);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch { /* ignore */ }
}

function saveLatestImage(images: string[]): void {
  try {
    fs.writeFileSync(LATEST_IMAGE_FILE, JSON.stringify({ images, savedAt: Date.now() }));
  } catch { /* ignore */ }
}


/** Returns history thresholds appropriate for the given model/think state. */
function getHistoryConfig(model: string, think: boolean): { compressThreshold: number; keepRecent: number } {
  const isExtended = model === MODELS.CODER || model === MODELS.ARCHITECT || (model === MODELS.COORDINATOR && think);
  return isExtended
    ? { compressThreshold: HISTORY_COMPRESS_THRESHOLD_EXT, keepRecent: HISTORY_KEEP_RECENT_EXT }
    : { compressThreshold: HISTORY_COMPRESS_THRESHOLD, keepRecent: HISTORY_KEEP_RECENT };
}

/** Compress older history into a summary using qwen2.5:3b (secretary — fast, low cost). */
async function compressHistory(history: Message[], compressThreshold = HISTORY_COMPRESS_THRESHOLD, keepRecent = HISTORY_KEEP_RECENT): Promise<Message[]> {
  if (history.length <= compressThreshold) return history;

  const toCompress = history.slice(0, history.length - keepRecent);
  const recent = history.slice(history.length - keepRecent);

  const summaryPrompt = `Summarize this conversation in 3-5 bullet points. Keep key facts, decisions, and context.\n\n${toCompress.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n')}`;

  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODELS.SECRETARY,  // background task
        keep_alive: KEEP_ALIVE_PINNED,
        options: { num_ctx: 8192 },
        messages: [{ role: 'user', content: summaryPrompt }],
        stream: false,
      }),
    });
    const data = await resp.json() as OllamaResponse;
    const summary = extractContent(data.message.content);
    log(`History compressed: ${toCompress.length} messages → summary`);
    return [{ role: 'assistant', content: `[Conversation summary]\n${summary}` }, ...recent];
  } catch {
    log('History compression failed, trimming instead');
    return recent;
  }
}

/**
 * Hard-cap history for inference to prevent Ollama hangs.
 * 1. Truncates individual message content beyond MSG_CONTENT_MAX_CHARS
 * 2. Keeps only the most recent INFERENCE_MAX_MESSAGES
 * 3. Enforces total character budget of INFERENCE_MAX_CHARS
 * Applied just before sending to Ollama — does NOT modify persisted history.
 */
function trimHistoryForInference(history: Message[]): Message[] {
  // Truncate oversized individual messages (tool outputs, long responses)
  let trimmed = history.map((m) => {
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.length > MSG_CONTENT_MAX_CHARS) {
      return { ...m, content: content.slice(0, MSG_CONTENT_MAX_CHARS) + '\n[...truncated]' };
    }
    return m;
  });

  // Keep only most recent messages
  if (trimmed.length > INFERENCE_MAX_MESSAGES) {
    const dropped = trimmed.length - INFERENCE_MAX_MESSAGES;
    trimmed = trimmed.slice(-INFERENCE_MAX_MESSAGES);
    log(`History trimmed for inference: dropped ${dropped} oldest messages`);
  }

  // Enforce total character budget — drop oldest until under budget
  let totalChars = trimmed.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
  while (totalChars > INFERENCE_MAX_CHARS && trimmed.length > 2) {
    const removed = trimmed.shift()!;
    totalChars -= typeof removed.content === 'string' ? removed.content.length : 0;
  }

  return trimmed;
}

/**
 * Split an XML-formatted prompt into per-sender groups.
 * Returns an array of { sender, prompt } where each prompt contains only
 * that sender's messages (preserving the XML wrapper and context header).
 * If there's only one sender (or the prompt can't be parsed), returns the
 * original prompt as a single entry.
 */
function splitBySender(prompt: string): Array<{ sender: string; prompt: string }> {
  // Extract the context header (timezone etc.)
  const contextMatch = prompt.match(/<context[^>]*\/>\n?/);
  const header = contextMatch ? contextMatch[0] : '';

  // Extract individual <message> elements with sender
  const msgRegex = /<message\s+sender="([^"]*)"[^>]*>[\s\S]*?<\/message>/g;
  const messages: Array<{ sender: string; xml: string }> = [];
  let match;
  while ((match = msgRegex.exec(prompt)) !== null) {
    messages.push({ sender: match[1], xml: match[0] });
  }

  if (messages.length === 0) return [{ sender: 'unknown', prompt }];

  // Get unique senders in order of appearance
  const senders: string[] = [];
  for (const m of messages) {
    if (!senders.includes(m.sender)) senders.push(m.sender);
  }

  // Single sender — no splitting needed
  if (senders.length <= 1) return [{ sender: senders[0] || 'unknown', prompt }];

  // Multiple senders — group messages by sender, preserving order within each group
  return senders.map((sender) => {
    const senderMsgs = messages.filter((m) => m.sender === sender);
    return {
      sender,
      prompt: `${header}<messages>\n${senderMsgs.map((m) => m.xml).join('\n')}\n</messages>`,
    };
  });
}

// --- Secretary Direct Execution ---
// Simple queries that map to a single tool call bypass the coordinator entirely.
// The secretary (qwen2.5:3b) classifies, we pattern-match the intent to a tool,
// execute it, and format a brief response — ~300ms total vs ~5-8s through coordinator.

const DIRECT_PATTERNS: Array<{
  pattern: RegExp;
  tool: string;
  args: (match: RegExpMatchArray, text: string) => Record<string, unknown>;
  format: (result: string) => string;
}> = [
  {
    // "version", "what version", "build", "what's new", "changelog", "release notes"
    // Must be before status — "what version are you running" contains "running"
    pattern: /\b(?:version|build\s*(?:id|number)?|what(?:'s| is) (?:new|version|build|changed)|change\s*log|release\s*notes?|version\s*notes?|what changed)\b/i,
    tool: 'get_changelog',
    args: () => ({}),
    format: (r) => {
      const lines = r.split('\n').slice(0, 5);
      return lines.join('\n');
    },
  },
  {
    // "status", "are you online", "service status", "check services", "health check"
    pattern: /\b(?:(?:service\s*)?status|health(?:\s*check)?|backends?|check\s+services?|are you (?:online|up|ok|alive))\b/i,
    tool: 'service_status',
    args: () => ({}),
    format: (r) => r,
  },
  {
    // "help", "what can you do", "capabilities"
    pattern: /\b(?:help|what can you do|capabilities|commands|features)\b/i,
    tool: 'get_help',
    args: () => ({}),
    format: (r) => r,
  },
  {
    // "perf", "performance", "how fast", "response time", "benchmarks"
    pattern: /\b(?:perf(?:ormance)?|benchmarks?|response time|how fast|speed|latency)\b/i,
    tool: 'perf_summary',
    args: () => ({}),
    format: (r) => r,
  },
  {
    // "restart", "reboot", "reset"
    pattern: /^\s*(?:restart|reboot|reset)\s*$/i,
    tool: 'restart_self',
    args: () => ({}),
    format: () => 'Restarting now... 🔄',
  },
];

// Patterns for queries that should go straight to web_search
const WEB_DIRECT_PATTERN = /\b(?:weather|temperature|forecast|(?:what|how) (?:is|much|many|far|old|tall|long) (?:the |a )?(?:price|cost|population|distance|height|time|date|score)|stock price|exchange rate|current (?:time|date|weather|temperature|price|score))\b/i;

/**
 * Try to handle a message directly via the secretary path.
 * Returns the response string if handled, or null if the coordinator should take over.
 * Only fires for low-complexity, non-thinking, default-model messages.
 */
async function trySecretaryDirect(
  prompt: string,
  cls: MessageClassification,
  chatJid: string,
  groupFolder: string,
): Promise<string | null> {
  // Extract the last message's text content from the XML prompt
  const allMessages = [...prompt.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)];
  const userText = allMessages.length > 0
    ? allMessages[allMessages.length - 1][1].trim()
    : prompt;
  if (!userText || userText.length > 300) return null;

  // Web-direct: simple factual queries that just need a search
  if (cls.needsWeb && WEB_DIRECT_PATTERN.test(userText) && !cls.think) {
    try {
      const start = Date.now();
      const searchResult = await handleToolCall('web_search', { query: userText }, chatJid, groupFolder);
      if (searchResult && searchResult.length > 10) {
        // Use secretary to summarize the search result into a brief answer
        const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODELS.SECRETARY,
            messages: [
              { role: 'system', content: 'Answer the question in 1-2 sentences using the search results. Be direct.' },
              { role: 'user', content: `Question: ${userText}\n\nSearch results:\n${searchResult.slice(0, 2000)}` },
            ],
            keep_alive: KEEP_ALIVE_SPECIALIST,
            options: { num_ctx: 4096, temperature: 0.1, num_predict: 200 },
            stream: false,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json() as OllamaResponse;
          const answer = extractContent(data.message.content).trim();
          if (answer) {
            log(`[secretary-direct] web_search+summarize → ${Date.now() - start}ms (bypassed coordinator)`);
            return answer;
          }
        }
      }
    } catch (err) {
      log(`[secretary-direct] web_search failed: ${err instanceof Error ? err.message : String(err)} — falling through to coordinator`);
    }
    return null;
  }

  // Language registration: "register/add/set spanish, german for translation"
  const LANG_REGISTER = /\b(?:register|add|set|enable|subscribe)\b.*\b(?:translat|language)/i;
  if (LANG_REGISTER.test(userText)) {
    // Extract language names from the message
    const knownLangs: Record<string, string> = {
      english: 'en', spanish: 'es', german: 'de', french: 'fr', italian: 'it',
      portuguese: 'pt', russian: 'ru', chinese: 'zh', japanese: 'ja', korean: 'ko',
      arabic: 'ar', hindi: 'hi', turkish: 'tr', dutch: 'nl', polish: 'pl',
      swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el',
      czech: 'cs', romanian: 'ro', hungarian: 'hu', bulgarian: 'bg', croatian: 'hr',
      serbian: 'sr', slovak: 'sk', slovenian: 'sl', ukrainian: 'uk', hebrew: 'he',
      thai: 'th', vietnamese: 'vi', indonesian: 'id', malay: 'ms', tagalog: 'tl',
      persian: 'fa', urdu: 'ur', bengali: 'bn', tamil: 'ta', telugu: 'te',
      afrikaans: 'af', swahili: 'sw', catalan: 'ca', estonian: 'et', latvian: 'lv',
      lithuanian: 'lt', macedonian: 'mk', albanian: 'sq',
    };
    const found: string[] = [];
    const lower = userText.toLowerCase();
    for (const [name, code] of Object.entries(knownLangs)) {
      if (lower.includes(name)) found.push(code);
    }
    if (found.length > 0) {
      // Merge with existing languages
      const existing = getPref('translator_languages');
      let current: string[] = [];
      if (Array.isArray(existing)) current = existing.filter((l): l is string => typeof l === 'string');
      else if (typeof existing === 'string') { try { current = JSON.parse(existing); } catch { /* */ } }
      const merged = [...new Set([...current, ...found])];
      setGroupPref('translator_languages', merged);
      const codeToName = (c: string) => Object.entries(knownLangs).find(([, v]) => v === c)?.[0] || c;
      log(`[secretary-direct] registered languages: ${merged.join(', ')}`);
      return `✅ Translations enabled: ${merged.map(codeToName).join(', ')}`;
    }
    // No languages specified — check if any are already set
    const existing = getPref('translator_languages');
    let current: string[] = [];
    if (Array.isArray(existing)) current = existing.filter((l): l is string => typeof l === 'string');
    else if (typeof existing === 'string') { try { current = JSON.parse(existing); } catch { /* */ } }
    if (current.length > 0) {
      return `Translations already active: ${current.join(', ')}. Say which languages to add.`;
    }
    return 'Which languages should I translate to? e.g. "add spanish, german, bulgarian for translation"';
  }

  // Disable/clear translations: "turn off translation", "remove all languages", "stop translating"
  const LANG_DISABLE = /\b(?:(?:turn|switch)\s+off|disable|stop|remove\s+(?:all)?|clear|reset)\b.*\b(?:translat|language)/i;
  if (LANG_DISABLE.test(userText)) {
    setGroupPref('translator_languages', []);
    log('[secretary-direct] translations disabled');
    return '🔇 Translations off.';
  }

  // Remove specific languages: "remove spanish from translation"
  const LANG_REMOVE = /\b(?:remove|delete|unsubscribe|drop)\b.*\b(?:translat|language)/i;
  if (LANG_REMOVE.test(userText) && !LANG_DISABLE.test(userText)) {
    const knownLangs: Record<string, string> = {
      english: 'en', spanish: 'es', german: 'de', french: 'fr', italian: 'it',
      portuguese: 'pt', russian: 'ru', chinese: 'zh', japanese: 'ja', korean: 'ko',
      arabic: 'ar', hindi: 'hi', turkish: 'tr', dutch: 'nl', polish: 'pl',
      bulgarian: 'bg', swedish: 'sv', norwegian: 'no', greek: 'el', czech: 'cs',
      romanian: 'ro', hungarian: 'hu', ukrainian: 'uk', hebrew: 'he', thai: 'th',
    };
    const toRemove: string[] = [];
    const lower = userText.toLowerCase();
    for (const [name, code] of Object.entries(knownLangs)) {
      if (lower.includes(name)) toRemove.push(code);
    }
    if (toRemove.length > 0) {
      const existing = getPref('translator_languages');
      let current: string[] = [];
      if (Array.isArray(existing)) current = existing.filter((l): l is string => typeof l === 'string');
      else if (typeof existing === 'string') { try { current = JSON.parse(existing); } catch { /* */ } }
      const updated = current.filter((c) => !toRemove.includes(c));
      setGroupPref('translator_languages', updated);
      log(`[secretary-direct] removed languages: ${toRemove.join(', ')}`);
      return updated.length > 0
        ? `Removed ${toRemove.join(', ')}. Remaining: ${updated.join(', ')}`
        : 'All translation languages removed. Translations disabled.';
    }
  }

  // Tool-direct: simple queries that map to a single tool call.
  // Check patterns BEFORE complexity gate — version/status/help are always direct.
  for (const { pattern, tool, args, format } of DIRECT_PATTERNS) {
    const match = userText.match(pattern);
    if (!match) continue;

    try {
      const start = Date.now();
      const result = await handleToolCall(tool, args(match, userText), chatJid, groupFolder);
      const response = format(result);
      log(`[secretary-direct] ${tool} → ${Date.now() - start}ms (bypassed coordinator)`);
      return response;
    } catch (err) {
      log(`[secretary-direct] ${tool} failed: ${err instanceof Error ? err.message : String(err)} — falling through to coordinator`);
      return null;
    }
  }

  return null;
}

// --- Background Chat Translation ---
// For chat-type messages, translate to all registered listener languages.
// Runs in parallel with coordinator inference — fire-and-forget via IPC.

const LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans', ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan',
  cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek', en: 'English',
  es: 'Spanish', et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French',
  he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', id: 'Indonesian',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', nl: 'Dutch', no: 'Norwegian',
  pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sv: 'Swedish',
  th: 'Thai', tl: 'Tagalog', tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese',
  zh: 'Chinese',
};

function getLanguageNameLocal(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}

/**
 * Translate a chat message to all registered listener languages in parallel.
 * Sends each translation as a separate IPC message. Fire-and-forget.
 */
async function translateForListeners(
  userText: string,
  senderName: string,
  chatJid: string,
): Promise<void> {
  let rawLangs = getPref('translator_languages');
  // Handle double-serialized values (stored as string instead of array)
  if (typeof rawLangs === 'string') {
    try { rawLangs = JSON.parse(rawLangs); } catch { return; }
  }
  const langs = rawLangs as string[] | undefined;
  if (!langs || !Array.isArray(langs) || langs.length === 0) return;

  // Short messages aren't worth translating
  if (userText.length < 5) return;

  const translationStart = Date.now();

  // All languages in a single secretary call — uses separate model so it
  // doesn't block coordinator inference. 35B is used only for on-demand translations.
  const langList = langs.map((l) => getLanguageNameLocal(l)).join(', ');
  const translations: Array<{ lang: string; name: string; text: string }> = [];
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODELS.SECRETARY,
        messages: [
          { role: 'system', content: `Translate the text to each language listed. Verbatim — preserve tone, slang, intent. Return one translation per line, format: LANG: translation\nNo other text.` },
          { role: 'user', content: `Languages: ${langList}\n\nText: ${userText}` },
        ],
        keep_alive: KEEP_ALIVE_PINNED,
        options: { num_ctx: 2048, temperature: 0.1, num_predict: 500 },
        stream: false,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json() as OllamaResponse;
      const output = extractContent(data.message.content).trim();
      // Parse "Language: translation" lines
      for (const line of output.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const langName = line.slice(0, colonIdx).trim();
        const text = line.slice(colonIdx + 1).trim();
        if (!text) continue;
        // Match back to language code
        const matchedLang = langs.find(
          (l) => getLanguageNameLocal(l).toLowerCase() === langName.toLowerCase(),
        );
        if (matchedLang && text.toLowerCase() !== userText.trim().toLowerCase()) {
          translations.push({ lang: matchedLang, name: getLanguageNameLocal(matchedLang), text });
        }
      }
    }
  } catch {
    // Translation failed — no output
  }

  if (translations.length === 0) return;

  // Format matching host-side UX: italic lines with [Language] prefix
  const translationMsg = translations
    .map((t) => `_🌐 [${t.name}] ${t.text}_`)
    .join('\n\n');

  try {
    const ipcFile = path.join(IPC_MSG_DIR, `translate-${Date.now()}.json`);
    fs.mkdirSync(IPC_MSG_DIR, { recursive: true });
    fs.writeFileSync(ipcFile, JSON.stringify({ type: 'message', chatJid, text: translationMsg }));
    log(`[translate] ${translations.length} languages in ${Date.now() - translationStart}ms`);
  } catch { /* best effort */ }
}

/** Extract a plain string from Ollama message content (handles string, array, or schema object). */
export function extractContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) return String((block as { text: unknown }).text);
        return '';
      })
      .join('');
  }
  return '';
}



function readGroupFile(groupFolder: string, filename: string): string {
  const candidates = [
    `/workspace/group/${filename}`,
    `/workspace/extra/nanoclaw/groups/${groupFolder}/${filename}`,
  ];
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, 'utf8').trim();
      if (content) return content;
    } catch { /* not present */ }
  }
  return '';
}

export function getSystemPrompt(assistantName: string, groupFolder?: string): string {
  const claudeMd = groupFolder ? readGroupFile(groupFolder, 'CLAUDE.md') : '';
  const jarvisMd = groupFolder ? readGroupFile(groupFolder, 'jarvis.md') : '';

  const contextSection = [
    claudeMd ? `\n\n---\n*Group context (CLAUDE.md):*\n${claudeMd}` : '',
    jarvisMd ? `\n\n---\n*What I know about the user (jarvis.md):*\n${jarvisMd}` : '',
  ].join('');

  const jarvisMemoryPath = groupFolder
    ? `${WORKSPACE_PROJECT}/groups/${groupFolder}/jarvis.md`
    : `${WORKSPACE_PROJECT}/groups/jarvis.md`;

  return `You are ${assistantName}, a senior solutions architect running locally. You are a capable generalist — you handle most things directly, with depth. You also lead a team of specialist models, each an expert in their domain. You know when to handle something yourself and when calling in a specialist will genuinely improve the outcome. You are a partner, not just a tool.${contextSection}

*Your team:*

• *Secretary (qwen2.5:3b)* — fast classifier. Routes every message to the right model and tier before you see it. Also compresses conversation history in the background to keep context fresh. Never used for reasoning or complex tasks.
• *You (${assistantName} · qwen3.5:35b)* — team lead and coordinator. Strong across reasoning, analysis, writing, planning, and conversation. You route tasks to the right specialist and handle general conversation directly. When a task has a clear specialist fit (code → coder, images → artist, hard reasoning → analyst), delegate immediately rather than attempting it yourself first.
• *Coder (qwen3-coder:30b)* — software development expert. Auto-assigned for coding tasks: writing, debugging, reviewing, and refactoring code. Evicts from VRAM immediately after use to free space.
• *Artist / Cinematographer (qwen2.5vl:72b)* — visual expert and creative director. Sees reference images directly. Crafts expert image and video generation prompts, selects the best backend, and executes generation end-to-end. Use generate_art for images, generate_film for videos. Consult via ollama_generate with model "artist" for visual advice without generating. Evicts from VRAM immediately after use.
• *Analyst (you + thinking mode)* — not a separate model. When you enable thinking mode (think=true), you gain sustained multi-step reasoning for trade-off evaluation and careful decisions. The secretary routes complex messages here automatically.
• *Architect (deepseek-r1:70b)* — maximum capability. Extended chain-of-thought, the hardest problems, final escalation. Only loaded when needed — evicts from VRAM immediately after use.

*Bringing in an expert — think of it like making a phone call:*

You are the point of contact. Every message comes to you first. When a task needs an expert, you pick up the phone and call them — either because the user asked for it, or because you judged it would improve your answer. You wait for their answer, then you synthesise and respond. You don't need to keep the expert in the room — just know when to dial.

It's OK for the phone to ring while you're waiting on an expert. If the user sends a follow-up message mid-task, it's queued and delivered to you when the current call finishes.

• *escalate* — Full handoff. The expert picks up exactly where you left off with full context. Use when the task as a whole is beyond your current tier.
• *ollama_generate* — Targeted consult. You stay in control; the specialist answers one focused question and you synthesise the result. Use for: scoped subtasks, draft + critique, parallel opinions, or a fast specialist question without handing off the whole conversation.

*Your capabilities — know these precisely:*

• *Chat & reasoning* — general questions, analysis, brainstorming, explanations. Use escalate to route to a deeper reasoning tier when needed.
• *Web* — web_search searches the live web via local SearXNG (privacy-first metasearch — no external tracking). fetch_url reads any URL as clean text. Use these for current events, documentation, anything that needs live information. Do not guess or hallucinate — search first.
• *Image generation* — call generate_art to consult the Artist (qwen2.5vl:72b). The Artist sees reference images, crafts an expert prompt, and returns a plan. Share the plan with the user for confirmation, then call ollama_generate with the Artist's prompt (embellish=false) to execute. For direct control, call ollama_generate with model "flux" and your own prompt.
  Available backends: ComfyUI (FLUX T2I — highest quality, 1024x1024), OllamaDiffuser (FLUX/SD/PixArt — supports I2I with reference images), Ollama (fallback).
  Installed image models: use diffuser_list_models to check. Best quality: flux.1-dev. Fastest: flux.2-klein-4b, sdxl-turbo. Best I2I: flux.2-klein-4b with use_reference=true. Photorealistic: realvisxl-v4.
• *Video generation* — call generate_film to consult the Cinematographer (qwen2.5vl:72b). Returns a cinematic plan to share with the user. After confirmation, call generate_video with the prompt to execute.
  Available backends: ComfyUI (LTX-Video 2B — T2V and I2V with start frame), OllamaDiffuser (ltx-video-2b, hunyuan-video, hunyuan-video-i2v).
  I2V: if the user sends a photo, it can be used as the start frame. The first frame sets the visual identity; the prompt describes the motion.
• *Vision* — describe or reason about images the user sends. Images arrive as "[X image(s) attached]" in the message.
• *Scheduling* — schedule_task creates recurring or one-off tasks. Tasks run as new conversations in this chat at the scheduled time. Support: once (timestamp), interval (ms), cron expression. Confirm details with the user before creating. Use schedule_task(list) to show active tasks.
• *Shell commands* — run_command executes shell commands in /workspace/extra/nanoclaw. Use only when the user explicitly asks you to run commands or inspect/edit your own code.
• *Memory* — you maintain a jarvis.md file with notes about the user and your own learnings.
• *Self-restart* — restart_self clears your session and conversation history.
• *Model management* — You can add, try, and remove models at runtime without rebuilding. For Ollama (text/reasoning): ollama_list_models, ollama_pull, ollama_remove. Browse available models at ollama.com/library — use web_search to find models by capability. For OllamaDiffuser (images/video): diffuser_list_models shows both installed and available models — available models auto-download on first use, no separate pull needed. For ComfyUI (advanced workflows): comfyui_list_models shows installed checkpoints/UNETs/LoRAs. To try a new Ollama model: pull it, then call ollama_generate with the model name. To try a new diffuser model: just use it in generate_art or generate_video — it downloads automatically.

• *Service management* — service_status checks all four backends in parallel. manage_service starts or restarts any backend (ollama, searxng, comfyui, ollamadiffuser). If a tool fails because a backend is down, start it yourself — don't ask the user to do it.

Never claim uncertainty about these capabilities. If something fails, report the actual error — do not speculate about whether the capability exists. You have full visibility into your own infrastructure: you can check what models are installed, what services are running, search for and install new models, and manage your own configuration. If a user asks whether a better model exists for a task, use web_search + ollama.com/library or diffuser_list_models to research alternatives and make a recommendation. You are an expert in your own stack.

*Your three core goals:*

1. *Responsive, accurate, and trustworthy.* Never guess — if you don't know, say so and figure it out together. Find the right expert or the right answer. Accuracy matters more than speed.

2. *Proactively improve.* You manage your own development. Notice patterns in what works and what doesn't. Suggest optimizations to your setup, workflows, and responses. You are part of your own development team.

3. *Lead like an architect.* Think before you speak. Understand the full problem before proposing a solution. Know your team's strengths and route to the right specialist immediately when the fit is clear. Code goes to the coder. Images go to the artist. Complex reasoning goes to the analyst. You orchestrate and handle general conversation — but you delegate readily. A good leader routes fast, not reluctantly.

Use Telegram formatting only: *bold* (single asterisks only), _italic_, • bullets, \`\`\`code\`\`\`. No headings. Be concise and conversational — short replies unless detail is needed.

*Language behaviour:*
- Respond in the same language the user writes in. If the user writes in Spanish, respond in Spanish. If English, respond in English.
- Exception: if a user has a "response_language" preference set (via the preferences tool), always use that language for responses to them regardless of input language.
- Do NOT translate your own responses or commands directed at you. The infrastructure silently translates member-to-member communication — text and voice messages are auto-translated to subscribed languages, and users react with 👀 for on-demand translation.
- When not actively engaged with anyone, you are in *passive mode* — do not speak unless spoken to. The infrastructure acts as a silent translator with no added or modified content.
- All translations (when you are asked directly) must be verbatim — word-for-word, not paraphrased or summarized. No added context, no explanations, no reformatting.

*Reasoning* — call set_status to narrate non-trivial steps as you work: e.g. "Analyzing the request...", "Checking available models...", "Enhancing prompt...". This keeps the user informed in real time.

*Honesty rules — non-negotiable:*
- Never describe a UI path, setting, menu, or external interface you haven't verified exists. If you're unsure whether a setting exists in an app, say so.
- Never claim a capability or limitation about yourself that isn't documented above. Your capabilities are listed at the top of this prompt — refer to them, not to guesses.
- If a tool call fails, report the actual error message. Do not speculate about why it might have failed or whether the capability exists.
- "I don't know" is always better than a confident wrong answer.

*Self-review* — before every response, silently check: (1) does it fully address what the user asked? (2) am I certain, or guessing? (3) is the format right? Only surface this review if a check fails or there is a reasoning error — otherwise log it internally and say nothing.

*Group chat engagement* — You are a guest in their conversation, not the main character.

You have two modes: **engaged** (a user addressed you) and **ambient** (listening passively).

**Deciding whether to respond:**
If you decide NOT to respond, output exactly \`<silent/>\` and nothing else.

Consider these factors:
- *Just helped?* — If you just completed a task for someone, your attention is higher. A follow-up from them probably wants your attention even without your name.
- *Multiple skill keywords?* — If someone mentions weather + location, or code + error, they might want help. But a single keyword in casual conversation doesn't warrant jumping in.
- *Name mentioned but no task?* — "Jarvis is cool" or "ask Jarvis later" — do NOT respond. Your name in passing is not a request.
- *Name + greeting/question/command?* — "Hi Jarvis", "Jarvis help", "Jarvis what time is it" — respond and engage.
- *Engaged user, casual remark?* — "lol", "nice", "ok" — stay silent, stay engaged.
- *Engaged user, question or task?* — respond naturally.
- *Dismissal?* — "bye", "thanks", "done", "nah", "that's all" — brief goodbye, include \`<disengage:USERID/>\`.

**Rules:**
- Keep responses short. One message, not three.
- Do NOT ask "anything else?" — answer and go quiet.
- Do NOT dominate the conversation.
- When in doubt, stay silent. It is always better to miss a cue than to intrude.

Special modes:
• "Jarvis, talk to everyone" or "group mode" — engage with all members. <disengage:all/> to stop.
• "Jarvis, just talk to me" — individual engagement (default).

You can restart yourself using the restart_self tool when asked, or to recover from a bad state.

You have read-write access to your own git repo at /workspace/extra/nanoclaw via run_command. Use it to read files, make edits with shell commands (sed, tee, etc.), and commit changes with git. Your git identity is pre-configured. You cannot push — ask the user to push when ready. Only use run_command for git operations when the user explicitly asks you to change or inspect your own code. Never run git commands in response to normal messages or images.

*Memory* — you maintain a personal memory file at \`${jarvisMemoryPath}\`. Use run_command to update it. Two sections:

\`## About the user\` — facts about the user: name, preferences, working style, interests, recurring projects, anything that helps you serve them better over time.

\`## Learnings\` — lessons from your own performance: what worked, what failed and why, corrections the user made, patterns worth keeping. The goal: never repeat a mistake, keep improving.

*Update proactively — don't wait to be asked.* Specific triggers:
- User corrects you or your approach → log what was wrong and what to do instead
- You learn a preference, habit, or constraint → note it
- A task type or tool behaves unexpectedly → log it
- An ongoing project or context shift comes up → note it
- You produce an unusually good answer for a recurring type of question → log what made it work

One line per entry. Create the file if it doesn't exist. Commit silently after each update. Skip trivial one-off exchanges — prioritise anything that changes how you'd handle *future* interactions.

*Video generation workflow* — same interactive approach as images:
1. Ask for a description if not provided.
2. If the message says "[Reference video available...]" or "[X image(s) attached]", tell the user what context you have:
   - Single image/video frame: will be used as the start frame (I2V).
   - Multiple images: first image = start frame; remaining images are described and added as context.
   Ask if they want to use it or start fresh. If they say "fresh", "no reference", or "ignore", the Cinematographer will generate from text only.
3. Confirm the final request with the user before generating.
4. Call generate_film with the user's request. The Cinematographer sees the reference images directly, crafts a cinematic prompt, and handles generation end-to-end. For direct control (user has written their own detailed cinematic prompt), use generate_video instead.
   - Do NOT ask the user to open apps or check if services are running — just call the tool. If ComfyUI or OllamaDiffuser isn't available, the tool will return an error explaining what to do.
   - Do NOT confuse video generation with image generation — never suggest flux or image models for video tasks.
5. Tell the user which backend and model was used, and any notes from the Cinematographer.

*Image generation workflow* — follow this exact sequence every time:
1. If the task involves editing or referencing an existing image: ask the user to send the image(s), one at a time. Wait.
2. Once you receive images (message says "[X image(s) attached]"): confirm the count, e.g. "Got 2 images." Then ask whether more are coming or if they're ready to proceed.
3. Ask for the generation prompt: "What would you like me to do?" or "Describe what you want."
4. Only after you have both the image(s) (if needed) and the request: call generate_art with the user's request. The Artist sees the reference images directly, crafts an expert prompt, and handles generation end-to-end. If the user says "fresh" or "no reference", the Artist will generate from text only. If the user has already written a very detailed prompt and says "use exactly this" or "no embellish", use ollama_generate with model "x/flux2-klein:9b" and embellish: false instead.

For text-to-image (no source image needed): skip steps 1–2, go straight to step 3, then generate.

Never generate an image without first confirming the request with the user. "[Photo]" in past history does NOT mean images are currently available — only treat images as present when the current message says "[X image(s) attached]".`;
}

// Normalize short model names to installed full names
export const MODEL_ALIASES: Record<string, string> = {
  'flux': 'x/flux2-klein:9b',
  'llama': MODELS.VISION,
  'vision': MODELS.VISION,
  'coder': MODELS.CODER,
  'artist': MODELS.VISION,
  'secretary': MODELS.SECRETARY,
};

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model.toLowerCase()] ?? model;
}

// Image-generation models — detected by name prefix
export const IMAGE_MODELS = ['flux', 'stable-diffusion', 'sdxl', 'dall-e'];

export function isImageModel(model: string): boolean {
  const lower = model.toLowerCase();
  return IMAGE_MODELS.some((m) => lower.includes(m));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timeout]);
}

export async function handleToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  chatJid: string,
  groupFolder: string,
  setStatus?: (text: string) => void,
): Promise<string> {
  if (toolName === 'set_status') {
    const text = String(toolArgs.text ?? '').trim();
    if (text && setStatus) setStatus(`_${text}_`);
    return ''; // no visible tool result — model continues
  }

  if (toolName === 'get_help') {
    return `*What I can do* (v${buildId})

🗣 *Chat & Reasoning*
• Ask questions, brainstorm, get explanations — I handle most things directly
• Say "think harder" or "step by step" for deeper reasoning mode
• Say "stop" or "cancel" to cut off a long response

🌐 *Web*
• "Search for [topic]" — I'll search the live web and summarise results
• "Read [URL]" — I'll fetch and read any page
• I use web search proactively when I need current information

🖼 *Images*
• "Generate an image of [description]" — Artist (qwen2.5vl) crafts an expert prompt and generates
• Send me photos and I'll describe, edit, or use them as reference

🎬 *Video*
• "Generate a video of [description]" — Cinematographer (qwen2.5vl) crafts a cinematic prompt and generates
• "Use this as a start frame" to animate a reference image

🎙 *Voice*
• Send voice notes — I'll transcribe and respond

⏰ *Scheduling*
• "Remind me tomorrow at 9am to [thing]" — I'll set a task that runs in this chat
• "Every morning, check [X] and tell me" — recurring tasks, cron or interval
• "Show my tasks" — list active scheduled tasks

🧠 *Memory*
• I keep notes between sessions and update them proactively
• Each chat group has its own isolated memory

💻 *Code & Commands*
• I can run shell commands in my workspace (ask me to)
• I can read and edit files in my git repo at /workspace/extra/nanoclaw

📋 *Other*
• "What's new?" or "changelog" — see what's changed
• "Help" — this menu`;
  }

  if (toolName === 'get_changelog') {
    try {
      const changelogPath = CHANGELOG_FILE;
      const raw = fs.readFileSync(changelogPath, 'utf-8');
      const changelog = JSON.parse(raw) as Record<string, { date: string; title: string; notes: string[] }>;
      const versions = Object.keys(changelog).sort((a, b) => {
        const [ma, mi, pa] = a.split('.').map(Number);
        const [mb, mi2, pb] = b.split('.').map(Number);
        return (mb - ma) || (mi2 - mi) || (pb - pa);
      });

      const wantAll = toolArgs.all === true;
      const versionArg = toolArgs.version ? String(toolArgs.version).trim() : null;

      let selectedVersions: string[];
      if (wantAll) {
        selectedVersions = versions;
      } else if (versionArg && versionArg.includes('-')) {
        const [from, to] = versionArg.split('-').map((v) => v.trim());
        selectedVersions = versions.filter((v) => {
          const [ma, mi, pa] = v.split('.').map(Number);
          const [fa, fi, fp] = from.split('.').map(Number);
          const [ta, ti, tp] = to.split('.').map(Number);
          const n = ma * 10000 + mi * 100 + pa;
          return n >= fa * 10000 + fi * 100 + fp && n <= ta * 10000 + ti * 100 + tp;
        });
      } else if (versionArg) {
        selectedVersions = versions.filter((v) => v === versionArg);
      } else {
        selectedVersions = versions.slice(0, 1); // current (latest) only
      }

      if (selectedVersions.length === 0) {
        return `No changelog entry found${versionArg ? ` for version ${versionArg}` : ''}.`;
      }


      return selectedVersions.map((v) => {
        const entry = changelog[v];
        const isCurrent = v === buildId;
        const header = `*v${v}${isCurrent ? ' (current)' : ''} — ${entry.title}*`;
        const dateStr = `_${entry.date}_`;
        const notes = entry.notes.map((n) => `• ${n}`).join('\n');
        return `${header}\n${dateStr}\n\n${notes}`;
      }).join('\n\n---\n\n');
    } catch {
      return 'No changelog available right now.';
    }
  }

  if (toolName === 'ollama_list_models') {
    const resp = await withTimeout(fetch(`${OLLAMA_HOST}/api/tags`), 10_000, 'ollama_list_models');
    const data = await resp.json() as { models: Array<{ name: string; size: number }> };
    return data.models.map((m) => `• ${m.name} (${(m.size / 1e9).toFixed(1)}GB)`).join('\n');
  }

  if (toolName === 'ollama_pull') {
    const name = String(toolArgs.name ?? '').trim();
    if (!name) return 'Error: no model name provided';
    if (setStatus) setStatus(`_Pulling ${name}..._`);
    const resp = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: false }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Pull failed: ${resp.status} — ${err}`);
    }
    const result = await resp.json() as { status?: string };
    return `✅ Pulled ${name} successfully. ${result.status || ''}`.trim();
  }

  if (toolName === 'ollama_remove') {
    const name = String(toolArgs.name ?? '').trim();
    if (!name) return 'Error: no model name provided';
    const resp = await fetch(`${OLLAMA_HOST}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Remove failed: ${resp.status} — ${err}`);
    }
    return `✅ Removed ${name}.`;
  }

  if (toolName === 'diffuser_list_models') {
    const odHost = process.env.OLLAMADIFFUSER_HOST || 'http://host.docker.internal:8001';
    const resp = await withTimeout(fetch(`${odHost}/api/models`, { signal: AbortSignal.timeout(5000) }), 10_000, 'diffuser_list_models');
    if (!resp.ok) throw new Error(`OllamaDiffuser error: ${resp.status}`);
    const data = await resp.json() as Record<string, unknown>;
    const installed = Array.isArray(data.installed) ? data.installed.filter((m: unknown): m is string => typeof m === 'string') : [];
    const available = Array.isArray(data.available) ? data.available.filter((m: unknown): m is string => typeof m === 'string') : [];
    const notInstalled = available.filter((m: string) => !installed.includes(m));
    const lines: string[] = [];
    if (installed.length) lines.push('*Installed:*\n' + installed.map((m: string) => `• ${m}`).join('\n'));
    if (notInstalled.length) lines.push('*Available to download:*\n' + notInstalled.map((m: string) => `• ${m}`).join('\n'));
    return lines.join('\n\n') || 'No models found.';
  }

  if (toolName === 'comfyui_list_models') {
    const comfyHost = process.env.COMFYUI_HOST || 'http://host.docker.internal:8000';
    const sections: string[] = [];
    // Checkpoints
    try {
      const resp = await fetch(`${comfyHost}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json() as Record<string, { input?: { required?: { ckpt_name?: [string[]] } } }>;
        const ckpts = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
        if (ckpts.length) sections.push('*Checkpoints:*\n' + ckpts.map((c: string) => `• ${c}`).join('\n'));
      }
    } catch (err) { log(`ComfyUI checkpoints query failed: ${err instanceof Error ? err.message : String(err)}`); }
    // UNETs (FLUX)
    try {
      const resp = await fetch(`${comfyHost}/object_info/UNETLoader`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json() as Record<string, { input?: { required?: { unet_name?: [string[]] } } }>;
        const unets = data?.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
        if (unets.length) sections.push('*UNETs:*\n' + unets.map((u: string) => `• ${u}`).join('\n'));
      }
    } catch (err) { log(`ComfyUI UNETs query failed: ${err instanceof Error ? err.message : String(err)}`); }
    // LoRAs
    try {
      const resp = await fetch(`${comfyHost}/object_info/LoraLoader`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json() as Record<string, { input?: { required?: { lora_name?: [string[]] } } }>;
        const loras = data?.LoraLoader?.input?.required?.lora_name?.[0] ?? [];
        if (loras.length) sections.push('*LoRAs:*\n' + loras.map((l: string) => `• ${l}`).join('\n'));
      }
    } catch (err) { log(`ComfyUI LoRAs query failed: ${err instanceof Error ? err.message : String(err)}`); }
    return sections.join('\n\n') || 'ComfyUI is not running or has no models installed.';
  }

  if (toolName === 'preferences') {
    const action = String(toolArgs.action ?? '').trim();
    const key = String(toolArgs.key ?? '').trim();
    const scope = String(toolArgs.scope ?? 'group').trim();
    const userId = toolArgs.user_id ? String(toolArgs.user_id).trim() : undefined;

    if (action === 'list') {
      const prefs = loadPreferences();
      const lines: string[] = [];
      if (Object.keys(prefs.group).length) {
        lines.push('*Group defaults:*');
        for (const [k, v] of Object.entries(prefs.group)) {
          lines.push(`  • ${k}: ${JSON.stringify(v)}`);
        }
      }
      for (const [uid, userPrefs] of Object.entries(prefs.users)) {
        if (Object.keys(userPrefs).length) {
          lines.push(`\n*User ${uid} overrides:*`);
          for (const [k, v] of Object.entries(userPrefs)) {
            lines.push(`  • ${k}: ${JSON.stringify(v)}`);
          }
        }
      }
      return lines.length > 0 ? lines.join('\n') : 'No preferences set.';
    }

    if (action === 'get') {
      if (!key) return 'Error: key is required for get';
      const val = getPref(key, userId);
      return val !== undefined ? `${key} = ${JSON.stringify(val)}` : `${key} is not set.`;
    }

    if (action === 'set') {
      if (!key) return 'Error: key is required for set';
      const value = toolArgs.value;
      if (scope === 'user') {
        if (!userId) return 'Error: user_id is required for user scope';
        setUserPref(userId, key, value);
        return `✅ Set ${key} = ${JSON.stringify(value)} for user ${userId}`;
      }
      setGroupPref(key, value);
      return `✅ Set ${key} = ${JSON.stringify(value)} for this group`;
    }

    return 'Error: action must be get, set, or list';
  }

  if (toolName === 'perf_summary') {
    const version = toolArgs.version ? String(toolArgs.version).trim() : buildId;
    const summary = summarizePerf(version);
    if (summary.entries === 0) return `No performance data for v${version}.`;
    const lines = [
      `*Performance: v${version}*`,
      `Responses: ${summary.responses}`,
      `Avg response: ${summary.avgResponseMs}ms`,
      `P95 response: ${summary.p95ResponseMs}ms`,
      `Avg classify: ${summary.avgClassifyMs ?? 'n/a'}ms`,
      `Think rate: ${summary.thinkRate}`,
      `Escalations: ${summary.escalations}`,
    ];
    const breakdown = summary.modelBreakdown as Record<string, number> | undefined;
    if (breakdown && Object.keys(breakdown).length > 0) {
      lines.push('', '*Model usage:*');
      for (const [model, count] of Object.entries(breakdown)) {
        lines.push(`  • ${model}: ${count}`);
      }
    }
    return lines.join('\n');
  }

  if (toolName === 'manage_service') {
    const service = String(toolArgs.service ?? '').trim();
    const action = String(toolArgs.action ?? 'start').trim();
    if (!service) return 'Error: no service specified';
    if (setStatus) setStatus(`_${action === 'restart' ? 'Restarting' : 'Starting'} ${service}..._`);
    try {
      fs.mkdirSync(IPC_TASKS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(IPC_TASKS_DIR, `svc-${Date.now()}.json`),
        JSON.stringify({ type: 'manage_service', service, action }),
      );
    } catch (err) {
      return `Error: failed to write IPC task — ${err instanceof Error ? err.message : String(err)}`;
    }
    return `✅ ${action === 'restart' ? 'Restart' : 'Start'} requested for ${service}. Check service_status in a few seconds to confirm.`;
  }

  if (toolName === 'service_status') {
    const checks = await Promise.allSettled([
      fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok),
      fetch(`${process.env.COMFYUI_HOST || 'http://host.docker.internal:8000'}/system_stats`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok),
      fetch(`${process.env.OLLAMADIFFUSER_HOST || 'http://host.docker.internal:8001'}/api/models`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok),
      fetch(`${process.env.SEARXNG_HOST || 'http://host.docker.internal:8888'}/healthz`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok),
    ]);
    const status = (r: PromiseSettledResult<boolean>) => r.status === 'fulfilled' && r.value ? '🟢 online' : '🔴 offline';
    return [
      `*Ollama* (text/reasoning): ${status(checks[0])}`,
      `*ComfyUI* (image/video workflows): ${status(checks[1])}`,
      `*OllamaDiffuser* (image/video generation): ${status(checks[2])}`,
      `*SearXNG* (web search): ${status(checks[3])}`,
    ].join('\n');
  }

  if (toolName === 'comfyui_search_models') {
    const query = String(toolArgs.query ?? '').toLowerCase();
    const typeFilter = toolArgs.type ? String(toolArgs.type).toLowerCase() : null;
    if (!query) return 'Error: no search query provided';
    const comfyHost = process.env.COMFYUI_HOST || 'http://host.docker.internal:8000';
    // Read the local model catalog (shipped with ComfyUI Manager)
    let catalog: Array<Record<string, string>>;
    try {
      const catalogPath = '/app/ollama-runner/comfyui-model-list.json';
      // Try fetching from Manager API first, fall back to bundled catalog
      try {
        const resp = await fetch(`${comfyHost}/externalmodel/getlist`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json() as { models: Array<Record<string, string>> };
          catalog = data.models ?? [];
        } else { throw new Error('API unavailable'); }
      } catch {
        // Fall back to reading from the mounted host filesystem
        const localPath = `${process.env.COMFYUI_MANAGER_PATH || '/workspace/extra/nanoclaw'}/ComfyUI-src/custom_nodes/ComfyUI-Manager/model-list.json`;
        try {
          const raw = fs.readFileSync(localPath, 'utf-8');
          catalog = (JSON.parse(raw) as { models: Array<Record<string, string>> }).models ?? [];
        } catch {
          return 'Error: ComfyUI Manager model catalog not available. Is ComfyUI Manager installed?';
        }
      }
    } catch {
      return 'Error: could not load model catalog';
    }
    const results = catalog.filter((m) => {
      const text = `${m.name ?? ''} ${m.type ?? ''} ${m.base ?? ''} ${m.description ?? ''}`.toLowerCase();
      if (!text.includes(query)) return false;
      if (typeFilter && (m.type ?? '').toLowerCase() !== typeFilter) return false;
      return true;
    }).slice(0, 15);
    if (results.length === 0) return `No models found matching "${query}".`;
    return results.map((m) =>
      `*${m.name}*\nType: ${m.type ?? '?'} | Base: ${m.base ?? '?'} | Size: ${m.size ?? '?'}\nFile: ${m.filename ?? '?'} → ${m.save_path ?? '?'}\nURL: ${m.url ?? '?'}`
    ).join('\n\n---\n\n');
  }

  if (toolName === 'comfyui_install_model') {
    const url = String(toolArgs.url ?? '').trim();
    const filename = String(toolArgs.filename ?? '').trim();
    const savePath = String(toolArgs.save_path ?? '').trim();
    if (!url || !filename || !savePath) return 'Error: url, filename, and save_path are all required';
    const comfyHost = process.env.COMFYUI_HOST || 'http://host.docker.internal:8000';
    if (setStatus) setStatus(`_Installing ${filename}..._`);
    const resp = await fetch(`${comfyHost}/manager/queue/install_model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename, save_path: savePath }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Install failed: ${resp.status} — ${err}`);
    }
    // Start the download queue
    await fetch(`${comfyHost}/manager/queue/start`, { signal: AbortSignal.timeout(5000) }).catch((err) => {
      log(`ComfyUI Manager queue start failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return `✅ Queued download of ${filename} (${savePath}). Download runs in the background — check comfyui_list_models to verify when complete.`;
  }

  if (toolName === 'ollama_generate') {
    const model = resolveModel(String(toolArgs.model ?? 'qwen3:32b'));
    const prompt = String(toolArgs.prompt ?? '');
    const system = toolArgs.system ? String(toolArgs.system) : undefined;

    if (isImageModel(model)) {
      const useReference = toolArgs.use_reference !== false;
      const embellish = toolArgs.embellish !== false;
      const backend = (toolArgs.backend as ImageBackend | undefined) ?? 'auto';

      if (setStatus) setStatus(`_Generating image..._`);
      const { buffer, source } = await withTimeout(
        generateImage(model, prompt, backend, { useReference, embellish }),
        IMAGE_TOOL_TIMEOUT_MS,
        `generateImage(${model})`,
      );

      // Send enhanced prompt to chat
      const imageBase64 = buffer.toString('base64');
      fs.mkdirSync(IPC_MSG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(IPC_MSG_DIR, `img-${Date.now()}.json`),
        JSON.stringify({
          type: 'image',
          chatJid,
          imageBase64,
          caption: `_${prompt.slice(0, 200)}_`,
          timestamp: new Date().toISOString(),
        }),
      );
      return `✅ Image generated via ${source}! Sending to chat now...`;
    }

    // Text generation with a specific model
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      keep_alive: MODELS_PINNED.has(model) ? -1 : KEEP_ALIVE_SPECIALIST,
      stream: false,
    };
    const resp = await withTimeout(
      fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      TOOL_TIMEOUT_MS,
      `ollama_generate(${model})`,
    );
    if (!resp.ok) throw new Error(`Sub-model error: ${resp.status}`);
    const data = await resp.json() as OllamaResponse;
    return extractContent(data.message.content);
  }

  if (toolName === 'run_command') {
    const command = String(toolArgs.command ?? '').trim();
    if (!command) return 'Error: no command provided';
    const rawCwd = toolArgs.cwd ? String(toolArgs.cwd) : '';
    const cwd = rawCwd
      ? (path.isAbsolute(rawCwd) ? rawCwd : path.join(WORKSPACE_PROJECT, rawCwd))
      : WORKSPACE_PROJECT;

    try {
      const output = execSync(command, {
        cwd,
        timeout: 30_000,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: WORKSPACE_GITCFG,
          HOME: CONTAINER_HOME,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const result = output.toString().trim() || '(no output)';
      return `$ ${command}\n\n${result}`;
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
      const out = e.stdout?.toString().trim() || '';
      const errOut = e.stderr?.toString().trim() || e.message || String(err);
      const result = [out, errOut].filter(Boolean).join('\n') || 'Command failed with no output';
      return `$ ${command}\n\n${result}`;
    }
  }

  if (toolName === 'generate_art') {
    const request = String(toolArgs.request ?? '');
    if (!request) return 'Error: no request provided';

    if (setStatus) setStatus('_Consulting Artist..._');

    const refImages = loadReferenceImages();
    const hasRef = refImages && refImages.length > 0;

    const artistSystem = `You are a world-class digital artist specialising in AI image generation with Flux diffusion models. Your primary goal is to faithfully translate the user's intention into an expert-level generation prompt.

You can see any reference images provided. Use them to understand the subject, style, and context.

*Intention alignment — your most important job:*
- Understand WHAT the user actually wants, not just what they literally said. "Make it cooler" means something specific in context.
- If the request is vague, lean into the reference images and any prior context to fill in the gaps.
- Never override the user's aesthetic choices. If they say "simple", don't add "ultra-detailed 8k masterpiece".
- If the user provided a detailed prompt already, preserve their wording — enhance around the edges, don't rewrite.

Rules:
1. Write a detailed generation prompt. Include: subject and appearance, art style or photography style, lighting, composition, mood, color palette, quality modifiers where appropriate.
2. Choose the best backend: "comfyui" for pure text-to-image (highest quality, no reference needed), "ollamadiffuser" for image-to-image when editing a reference, "auto" to decide automatically.
3. Set use_reference: true if the user wants to edit or build on the reference image, false for a fresh generation.
4. Optionally include a note to the user with context about your interpretation and any suggestions.

Respond with ONLY valid JSON, no explanation, no markdown:
{"prompt": "...", "backend": "auto|comfyui|ollamadiffuser", "use_reference": true|false, "note": "optional"}`;

    const artistMessages = [
      { role: 'system', content: artistSystem },
      { role: 'user', content: request, ...(hasRef ? { images: refImages!.slice(0, 4) } : {}) },
    ];

    const artistResp = await withTimeout(
      fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODELS.VISION, messages: artistMessages, keep_alive: KEEP_ALIVE_SPECIALIST, options: { num_ctx: 8192 }, stream: false }),
      }),
      TOOL_TIMEOUT_MS,
      'generate_art(artist)',
    );
    if (!artistResp.ok) throw new Error(`Artist error: ${artistResp.status}`);
    const artistData = await artistResp.json() as OllamaResponse;
    const artistRaw = extractContent(artistData.message.content).trim();

    let artResult: { prompt: string; backend: ImageBackend; use_reference: boolean; note?: string };
    let jsonParseFailed = false;
    try {
      const jsonStr = artistRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      artResult = JSON.parse(jsonStr);
      if (!artResult.prompt || typeof artResult.prompt !== 'string') {
        throw new Error('Missing or invalid prompt field');
      }
    } catch (parseErr) {
      log(`Artist JSON parse failed — using raw as prompt: ${artistRaw.slice(0, 120)}`);
      artResult = { prompt: artistRaw, backend: 'auto', use_reference: !!hasRef };
      jsonParseFailed = true;
    }

    log(`Artist prompt: ${artResult.prompt.slice(0, 120)} | backend: ${artResult.backend} | ref: ${artResult.use_reference}`);

    const artNote = artResult.note ? `\n\nArtist note: ${artResult.note}` : '';
    const parseWarning = jsonParseFailed ? `\n\n⚠️ _Artist returned unstructured text instead of JSON — using raw output as prompt. Quality may vary._` : '';
    return `*Artist's interpretation:*\n_"${artResult.prompt.slice(0, 300)}"_\n\nBackend: ${artResult.backend} | Reference: ${artResult.use_reference ? 'yes' : 'no'}${artNote}${parseWarning}\n\n→ To generate, call ollama_generate with model "flux", this exact prompt, backend "${artResult.backend}", use_reference=${artResult.use_reference}, and embellish=false (already enhanced by the Artist).`;
  }

  if (toolName === 'generate_film') {
    const request = String(toolArgs.request ?? '');
    if (!request) return 'Error: no request provided';

    if (setStatus) setStatus('_Consulting Cinematographer..._');

    const refImages = loadReferenceImages();
    const hasRef = refImages && refImages.length > 0;

    const cinemaSystem = `You are an expert cinematographer and film director specialising in AI video generation. Your primary goal is to faithfully translate the user's vision into an expert cinematic prompt.

You can see any reference images provided. Use them to understand the scene, subject, and visual style.

*Intention alignment — your most important job:*
- Capture the user's vision first. Technical polish second.
- If the request describes a mood or feeling ("something dreamy", "intense action"), translate that into specific cinematic language — don't ask them to be more specific.
- Respect the user's creative direction. If they specify a shot type or style, use it. Don't override.

Rules:
1. Write a detailed cinematic prompt. Include: scene and subject, action and motion, camera movement (pan, tilt, track, static, handheld), pacing (slow motion, normal speed, time-lapse), lighting and atmosphere, visual style, mood, color grading.
2. Choose the best backend: "comfyui" for highest quality video, "ollamadiffuser" as an alternative, "auto" to decide automatically.
3. Set use_reference: true if the user wants to animate or extend the reference image as a start frame, false for pure text-to-video.
4. Optionally include a note with your cinematic interpretation and any suggestions.

Respond with ONLY valid JSON, no explanation, no markdown:
{"prompt": "...", "backend": "auto|comfyui|ollamadiffuser", "use_reference": true|false, "note": "optional"}`;

    const cinemaMessages = [
      { role: 'system', content: cinemaSystem },
      { role: 'user', content: request, ...(hasRef ? { images: refImages!.slice(0, 1) } : {}) },
    ];

    const cinemaResp = await withTimeout(
      fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODELS.VISION, messages: cinemaMessages, keep_alive: KEEP_ALIVE_SPECIALIST, options: { num_ctx: 8192 }, stream: false }),
      }),
      TOOL_TIMEOUT_MS,
      'generate_film(cinematographer)',
    );
    if (!cinemaResp.ok) throw new Error(`Cinematographer error: ${cinemaResp.status}`);
    const cinemaData = await cinemaResp.json() as OllamaResponse;
    const cinemaRaw = extractContent(cinemaData.message.content).trim();

    let filmResult: { prompt: string; backend: 'auto' | 'comfyui' | 'ollamadiffuser'; use_reference: boolean; note?: string };
    let filmJsonFailed = false;
    try {
      const jsonStr = cinemaRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      filmResult = JSON.parse(jsonStr);
      if (!filmResult.prompt || typeof filmResult.prompt !== 'string') {
        throw new Error('Missing or invalid prompt field');
      }
    } catch {
      log(`Cinematographer JSON parse failed — using raw as prompt: ${cinemaRaw.slice(0, 120)}`);
      filmResult = { prompt: cinemaRaw, backend: 'auto', use_reference: !!hasRef };
      filmJsonFailed = true;
    }

    log(`Cinematographer prompt: ${filmResult.prompt.slice(0, 120)} | backend: ${filmResult.backend} | ref: ${filmResult.use_reference}`);

    const filmNote = filmResult.note ? `\n\nCinematographer note: ${filmResult.note}` : '';
    const filmParseWarning = filmJsonFailed ? `\n\n⚠️ _Cinematographer returned unstructured text instead of JSON — using raw output as prompt. Quality may vary._` : '';
    return `*Cinematographer's interpretation:*\n_"${filmResult.prompt.slice(0, 300)}"_\n\nBackend: ${filmResult.backend} | Reference: ${filmResult.use_reference ? 'yes' : 'no'}${filmNote}${filmParseWarning}\n\n→ To generate, call generate_video with this exact prompt, backend "${filmResult.backend}", and use_reference=${filmResult.use_reference}.`;
  }

  if (toolName === 'generate_video') {
    const prompt = String(toolArgs.prompt ?? '');
    const backend = (toolArgs.backend as 'auto' | 'comfyui' | 'ollamadiffuser' | undefined) ?? 'auto';
    if (!prompt) return 'Error: no prompt provided';

    const useReference = toolArgs.use_reference !== false;
    log(`Video generation requested — backend: ${backend}, useRef: ${useReference}, prompt: ${prompt.slice(0, 80)}`);
    if (setStatus) setStatus(`_Generating video..._`);
    const { buffer, source, usedContext, effectivePrompt } = await withTimeout(
      generateVideo(prompt, backend, { useReference }),
      VIDEO_TOOL_TIMEOUT_MS,
      `generateVideo(${backend})`,
    );
    const videoBase64 = buffer.toString('base64');
    const sizeMb = (buffer.length / 1e6).toFixed(1);
    log(`Video generated via ${source}: ${sizeMb}MB (context: ${usedContext})`);

    // Print effective prompt if it differs from the original
    if (effectivePrompt !== prompt) {
      const promptFile = path.join(IPC_MSG_DIR, `prompt-${Date.now()}.json`);
      fs.mkdirSync(IPC_MSG_DIR, { recursive: true });
      fs.writeFileSync(promptFile, JSON.stringify({ type: 'message', chatJid, text: `_Prompt:_ ${effectivePrompt}` }));
    }

    const ipcFile = path.join(IPC_MSG_DIR, `vid-${Date.now()}.json`);
    fs.mkdirSync(IPC_MSG_DIR, { recursive: true });
    fs.writeFileSync(ipcFile, JSON.stringify({
      type: 'video',
      chatJid,
      videoBase64,
      caption: `_${prompt.slice(0, 200)}_`,
      timestamp: new Date().toISOString(),
    }));
    const contextNote = usedContext !== 'none' ? ` · context: ${usedContext}` : '';
    return `✅ Video generated via ${source} (${sizeMb}MB${contextNote}) — sending now...`;
  }

  if (toolName === 'restart_self') {
    // Clear history so the next session starts fresh
    try { fs.unlinkSync(HISTORY_FILE); } catch { /* already gone */ }
    // Write close sentinel — waitForIpcMessage() will see it and exit cleanly
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
    return 'Restarting...';
  }

  if (toolName === 'web_search') {
    const query = String(toolArgs.query ?? '').trim();
    const maxResults = Math.min(Number(toolArgs.max_results ?? 5), 10);
    if (!query) return 'Error: no query provided';

    if (setStatus) setStatus('_Searching..._');
    const searxHost = process.env.SEARXNG_HOST || 'http://host.docker.internal:8888';
    const url = `${searxHost}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
    const resp = await withTimeout(
      fetch(url, { headers: { Accept: 'application/json' } }),
      WEB_TOOL_TIMEOUT_MS,
      'web_search',
    );
    if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);
    const data = await resp.json() as { results?: Array<{ title: string; url: string; content?: string; engine?: string }> };
    const results = (data.results ?? []).slice(0, maxResults);
    if (results.length === 0) return 'No results found.';
    return results
      .map((r, i) => `**${i + 1}. ${r.title}**\n${r.url}\n${r.content ?? ''}`.trim())
      .join('\n\n---\n\n');
  }

  if (toolName === 'fetch_url') {
    const url = String(toolArgs.url ?? '').trim();
    if (!url || !url.startsWith('http')) return 'Error: invalid URL — must start with http or https';

    if (setStatus) setStatus('_Fetching page..._');
    // Jina reader converts any URL to clean markdown
    try {
      const resp = await withTimeout(
        fetch(`https://r.jina.ai/${url}`, {
          headers: { Accept: 'text/plain', 'X-Retain-Images': 'none' },
        }),
        WEB_TOOL_TIMEOUT_MS,
        'fetch_url(jina)',
      );
      if (resp.ok) {
        const text = await resp.text();
        return text.slice(0, 6000);
      }
    } catch { /* fall through to direct fetch */ }

    // Direct fetch fallback with basic HTML stripping
    const resp = await withTimeout(
      fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Jarvis/1.0)' } }),
      WEB_TOOL_TIMEOUT_MS,
      'fetch_url(direct)',
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.slice(0, 6000);
  }

  if (toolName === 'schedule_task') {
    const action = String(toolArgs.action ?? '');
    const ipcTasksDir = IPC_TASKS_DIR;

    if (action === 'list') {
      try {
        const snapshot = fs.readFileSync(IPC_CURRENT_TASKS, 'utf-8');
        const tasks = JSON.parse(snapshot) as Array<{ id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string | null }>;
        if (tasks.length === 0) return 'No scheduled tasks.';
        return tasks.map((t) =>
          `*${t.id}* [${t.status}]\n_${t.schedule_type}: ${t.schedule_value}_${t.next_run ? `\nNext run: ${new Date(t.next_run).toLocaleString()}` : ''}\nPrompt: ${t.prompt.slice(0, 100)}`,
        ).join('\n\n');
      } catch {
        return 'No scheduled tasks found (snapshot not yet written).';
      }
    }

    if (action === 'create') {
      const prompt = String(toolArgs.prompt ?? '').trim();
      const scheduleType = String(toolArgs.schedule_type ?? '');
      const scheduleValue = String(toolArgs.schedule_value ?? '').trim();
      if (!prompt || !scheduleType || !scheduleValue) return 'Error: create requires prompt, schedule_type, and schedule_value';

      // Group chat restriction: only reminders (text responses) allowed.
      // Execution tasks (code, config changes, service commands) require DM.
      const isGroupChat = chatJid.includes('-'); // group JIDs have negative IDs
      if (isGroupChat) {
        const isReminder = /\b(?:remind|reminder|notify|alert|ping|tell\s+me|let\s+me\s+know)\b/i.test(prompt);
        if (!isReminder) {
          return 'Execution tasks can only be scheduled from a private DM. In group chats, I can only set reminders. Try: "remind me in 2 hours to..."';
        }
      }
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const contextMode = toolArgs.context_mode === 'isolated' ? 'isolated' : 'group';
      fs.mkdirSync(ipcTasksDir, { recursive: true });
      fs.writeFileSync(path.join(ipcTasksDir, `${taskId}.json`), JSON.stringify({
        type: 'schedule_task',
        taskId,
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        context_mode: contextMode,
        targetJid: chatJid,
      }));
      log(`Task created: ${taskId} (${scheduleType}: ${scheduleValue})`);
      return `✅ Task scheduled (ID: \`${taskId}\`)\n_${scheduleType}: ${scheduleValue}_\n_Context: ${contextMode}_`;
    }

    const taskId = String(toolArgs.task_id ?? '').trim();
    if (!taskId) return `Error: task_id required for ${action}`;
    const ipcTypeMap: Record<string, string> = { cancel: 'cancel_task', pause: 'pause_task', resume: 'resume_task' };
    const ipcType = ipcTypeMap[action];
    if (!ipcType) return `Error: unknown action "${action}"`;
    fs.mkdirSync(ipcTasksDir, { recursive: true });
    fs.writeFileSync(path.join(ipcTasksDir, `${action}-${taskId}-${Date.now()}.json`), JSON.stringify({ type: ipcType, taskId }));
    return `✅ Task ${taskId} ${action}d.`;
  }

  return `Unknown tool: ${toolName}`;
}

/** Detect a text-encoded tool call from models that don't use structured tool calling. */
function parseTextToolCall(content: string): { name: string; parameters: Record<string, unknown> } | null {
  const patterns = [
    /```(?:json)?\s*(\{[\s\S]*?\})\s*```/,
    /^\s*(\{"name"[\s\S]*?\})\s*$/,
  ];
  for (const pat of patterns) {
    const m = content.match(pat);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]);
        // Only allow safe tools via text-encoded calls — run_command requires explicit user intent
        const ALLOWED_TEXT_TOOLS = ['ollama_generate', 'ollama_list_models', 'generate_art', 'generate_film', 'generate_video', 'restart_self', 'run_command', 'get_changelog', 'get_help'];
        if (typeof parsed.name === 'string' && ALLOWED_TEXT_TOOLS.includes(parsed.name) && parsed.parameters && typeof parsed.parameters === 'object') {
          return { name: parsed.name, parameters: parsed.parameters as Record<string, unknown> };
        }
      } catch { /* not valid JSON */ }
    }
  }
  return null;
}

/** Returns the next reasoning tier for a given model/think state, or null if already at max. */
export function getEscalationTier(model: string, think: boolean): { model: string; think: boolean } | null {
  if (model === MODELS.CODER)                  return { model: MODELS.COORDINATOR, think: true };  // coder → analyst
  if (model === MODELS.COORDINATOR && !think)  return { model: MODELS.COORDINATOR, think: true };  // fast → analyst
  if (model === MODELS.COORDINATOR && think)   return { model: MODELS.ARCHITECT,   think: false }; // analyst → architect
  return null;                                                                                      // at max (architect)
}

export async function callOllama(
  model: string,
  messages: Message[],
  chatJid: string,
  groupFolder: string,
  images?: string[],
  temperature?: number,
  setStatus?: (text: string) => void,
  think?: boolean,
  onToolStart?: (toolName: string) => void,
  complexity?: 'low' | 'medium' | 'high',
): Promise<string> {
  // llama3.2-vision only supports one image per call.
  // When multiple images are provided, describe each separately and inject as text context.
  let resolvedImages = images;
  let resolvedMessages = messages;
  if (images && images.length > 1 && model === MODELS.VISION) {
    log(`Multiple images (${images.length}) with vision model — describing in parallel`);
    const descResults = await Promise.all(images.map((img, i) =>
      withTimeout(
        fetch(`${OLLAMA_HOST}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: `Describe image ${i + 1} in detail: subject, appearance, colors, style.`, images: [img] }],
            stream: false,
          }),
        }),
        30_000,
        `describe-image-${i + 1}`,
      ).then(async (r) => {
        if (!r.ok) return `Image ${i + 1}: (description unavailable)`;
        const d = await r.json() as OllamaResponse;
        return `Image ${i + 1}: ${extractContent(d.message.content).trim()}`;
      }).catch(() => `Image ${i + 1}: (description unavailable)`),
    ));
    const descriptions = descResults;
    // Inject descriptions as a prefix on the last user message; no images in main call
    const descContext = descriptions.join('\n\n');
    resolvedImages = undefined;
    resolvedMessages = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: `[Images provided]\n${descContext}\n\n${typeof m.content === 'string' ? m.content : ''}`.trim() }
        : m,
    );
  }

  // Attach images to the last user message if provided
  const messagesWithImages = resolvedImages && resolvedImages.length > 0
    ? resolvedMessages.map((m, i) =>
        i === resolvedMessages.length - 1 && m.role === 'user'
          ? { ...m, images: resolvedImages }
          : m,
      )
    : resolvedMessages;

  // Only send think: true for models that support the flag; architect always reasons internally
  const useThinkFlag = MODELS_WITH_THINK.has(model) && !!think;
  // Coordinator and secretary stay pinned; specialists evict after 60s to free VRAM.
  const keepAliveArgs = MODELS_PINNED.has(model) ? { keep_alive: KEEP_ALIVE_PINNED } : { keep_alive: KEEP_ALIVE_SPECIALIST };

  // Per-model options — tuned per mode:
  //   coordinator non-think: 16k context + tight sampling for speed (halved KV cache ≈ 2x faster attention)
  //   coordinator think:     64k context + wider sampling for reasoning accuracy
  //   architect:             64k context + accuracy profile (always-reasoning, needs space for CoT)
  //   coder:                 64k context (large codebases need room for file contents)
  //   vision:                32k context, no special tuning
  const isCoordinator = model === MODELS.COORDINATOR;
  const isCoder       = model === MODELS.CODER;
  const isArchitect   = model === MODELS.ARCHITECT;
  const isSecretary   = model === MODELS.SECRETARY;
  const isLowComplexity = complexity === 'low';
  const needsLargeCtx = (isCoordinator && !!think) || isArchitect || isCoder;
  const modelOpts: Record<string, unknown> = {
    // Low complexity: small context = faster prompt processing
    num_ctx: isSecretary ? 2048
      : isLowComplexity && isCoordinator ? 8192
      : (isCoordinator && !think) ? 16384
      : needsLargeCtx ? 65536 : 32768,
  };
  if (isCoordinator && !think) {
    // Speed mode: focused sampling reduces candidate evaluation overhead
    modelOpts.top_k = 20;
    modelOpts.top_p = 0.85;
  }
  if (isLowComplexity && isCoordinator) {
    // Fast path: tight sampling for quick responses
    modelOpts.top_k = 10;
    modelOpts.top_p = 0.8;
    modelOpts.num_predict = 512; // cap output length for simple replies
  }
  if (isCoordinator && think) {
    // Accuracy mode: wider candidate pool improves reasoning chain quality
    modelOpts.top_k = 50;
    modelOpts.top_p = 0.95;
    modelOpts.temperature = 0.1;
  }
  if (isCoder) {
    // Coder: accuracy over speed — deterministic, wide context, thorough sampling
    modelOpts.top_k = 40;
    modelOpts.top_p = 0.9;
    modelOpts.temperature = 0.15;
  }
  if (isArchitect) {
    // Architect: maximum accuracy — deep reasoning, full context, wide sampling
    modelOpts.top_k = 50;
    modelOpts.top_p = 0.95;
    modelOpts.temperature = 0.1;
  }
  if (temperature !== undefined && !(isCoordinator && think) && !isArchitect && !isCoder) modelOpts.temperature = temperature;

  const perfStart = Date.now();
  const roundTimings: number[] = [];

  const response = await withTimeout(
    fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messagesWithImages,
        // Vision models don't support tools. Low-complexity: minimal tools for speed.
        ...(MODELS_WITHOUT_TOOLS.has(model) ? {} : {
          tools: isLowComplexity
            ? OLLAMA_TOOLS.filter((t) => {
                const n = (t as { function: { name: string } }).function.name;
                return ['web_search', 'fetch_url', 'set_status', 'get_help', 'get_changelog',
                        'ollama_generate', 'escalate', 'service_status', 'preferences'].includes(n);
              })
            : OLLAMA_TOOLS,
        }),
        options: modelOpts,
        ...(useThinkFlag ? { think: true } : {}),
        ...keepAliveArgs,
        stream: false,
      }),
    }),
    TOOL_TIMEOUT_MS,
    `callOllama(${model})`,
  );

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as OllamaResponse;
  roundTimings.push(Date.now() - perfStart);
  let msg = data.message;
  // Running message context for follow-up calls (no images after first round)
  let currentMessages = messages;

  // Tool-call loop (up to 5 rounds)
  // Handles both structured tool_calls and text-encoded tool calls (for models that don't support structured calling)
  let rounds = 0;
  const commandOutputs: string[] = []; // collect run_command results to append verbatim
  while (rounds++ < 5) {
    // Normalise: convert text-encoded tool calls into structured ones when the model doesn't use the API
    if ((!msg.tool_calls || msg.tool_calls.length === 0) && msg.content) {
      const textTc = parseTextToolCall(extractContent(msg.content));
      if (textTc) {
        log(`Text-encoded tool call detected: ${textTc.name} — executing`);
        msg = { ...msg, tool_calls: [{ function: { name: textTc.name, arguments: textTc.parameters } }], content: '' };
      }
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    const toolResults: Message[] = [];
    for (const tc of msg.tool_calls) {
      // Escalation — hand off to next tier; backward-compatible with delegate_to_27b
      if (tc.function.name === 'escalate' || tc.function.name === 'delegate_to_27b') {
        const reason = String(tc.function.arguments?.reason ?? 'complex reasoning required');
        const next = getEscalationTier(model, think ?? false);
        if (next) {
          log(`Escalating ${model}${think ? '+think' : ''} → ${next.model}${next.think ? '+think' : ''} — ${reason}`);
          if (onToolStart) onToolStart('escalate');
          if (setStatus) setStatus(`Escalating to ${next.model}...`);
          return callOllama(next.model, messages, chatJid, groupFolder, images, temperature, setStatus, next.think, onToolStart);
        }
        log(`Escalation requested but already at max tier (${model}+think) — continuing`);
        toolResults.push({ role: 'tool', content: 'Already at maximum reasoning tier. Proceed with your best answer.' });
        continue;
      }
      if (onToolStart) onToolStart(tc.function.name);
      let result: string;
      const toolStart = Date.now();
      try {
        result = await handleToolCall(
          tc.function.name,
          tc.function.arguments,
          chatJid,
          groupFolder,
          setStatus,
        );
      } catch (err) {
        result = `Tool error (${tc.function.name}): ${err instanceof Error ? err.message : String(err)}`;
        log(`Tool call failed: ${result}`);
      }
      log(`[PERF] tool=${tc.function.name} ${Date.now() - toolStart}ms`);
      if (tc.function.name === 'run_command') commandOutputs.push(result!);
      toolResults.push({ role: 'tool', content: result! });
    }
    const followUpStart = Date.now();
    const followUp = await withTimeout(
      fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [...currentMessages, msg as Message, ...toolResults],
          ...(MODELS_WITHOUT_TOOLS.has(model) ? {} : { tools: OLLAMA_TOOLS }),
          options: modelOpts,
          ...(useThinkFlag ? { think: true } : {}),
          ...keepAliveArgs,
          stream: false,
        }),
      }),
      TOOL_TIMEOUT_MS,
      `callOllama follow-up(${model})`,
    );
    const next = await followUp.json() as OllamaResponse;
    roundTimings.push(Date.now() - followUpStart);
    msg = next.message;
    currentMessages = [...currentMessages, msg as Message, ...toolResults];
  }

  // Extract response and reasoning content
  // - qwen3+think:   reasoning is in msg.thinking (separate field from Ollama API)
  // - deepseek-r1:   reasoning is inline in <think>...</think> tags within the content
  let modelResponse: string;
  let thinkingContent: string;
  if (isArchitect) {
    const raw = extractContent(msg.content);
    const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
    thinkingContent = thinkMatch ? thinkMatch[1].trim() : (msg.thinking?.trim() ?? '');
    modelResponse = thinkMatch ? raw.replace(/<think>[\s\S]*?<\/think>/, '').trim() : raw;
  } else {
    modelResponse = extractContent(msg.content);
    thinkingContent = think && msg.thinking ? msg.thinking.trim() : '';
  }

  // When reasoning content is available, prepend it so the user can follow the steps
  const responseWithThinking = thinkingContent
    ? `💭 *Reasoning:*\n${thinkingContent}\n\n${modelResponse}`
    : modelResponse;

  const totalMs = Date.now() - perfStart;
  const thinkingMs = thinkingContent ? thinkingContent.length * 4 : 0; // rough estimate: ~4ms/char
  log(`[PERF] inference | model=${model} | think=${!!think} | rounds=${rounds - 1} | timings=[${roundTimings.join(',')}]ms | total=${totalMs}ms${thinkingContent ? ` | thinking_chars=${thinkingContent.length}` : ''} | response_chars=${modelResponse.length}`);

  // Always include command outputs verbatim, even if the model omits them
  if (commandOutputs.length > 0) {
    const outputBlock = commandOutputs.map((o) => `\`\`\`\n${o}\n\`\`\``).join('\n\n');
    return responseWithThinking ? `${responseWithThinking}\n\n${outputBlock}` : outputBlock;
  }

  // Auto-escalation: if the model apologized, failed, or received an error it couldn't resolve,
  // automatically retry at the next reasoning tier without requiring the model to self-escalate.
  if (AUTO_ESCALATE_PATTERN.test(modelResponse)) {
    const nextTier = getEscalationTier(model, think ?? false);
    if (nextTier) {
      log(`Auto-escalating (failure detected in response): ${model}${think ? '+think' : ''} → ${nextTier.model}${nextTier.think ? '+think' : ''}`);
      if (onToolStart) onToolStart('escalate');
      if (setStatus) setStatus(`Escalating to ${nextTier.model}...`);
      return callOllama(nextTier.model, messages, chatJid, groupFolder, images, temperature, setStatus, nextTier.think, onToolStart);
    }
  }

  return responseWithThinking;
}

interface TaskContext {
  description: string;
  getPhase: () => string;
  startedAt: number;
}

interface InterruptExchange {
  userMessage: string;
  quickReply: string;
}

/**
 * Run the main inference concurrently with an IPC poller.
 * While the main task is in progress, any messages that arrive in the IPC input
 * directory get an immediate brief response via qwen3.5:35b with task context.
 * Returns the main response plus all mid-task exchanges for history injection.
 */
async function runWithConcurrentPoll(
  mainTask: Promise<string>,
  ctx: TaskContext,
  chatJid: string,
  groupFolder: string,
  recentHistory: Message[],
  assistantNameLocal: string,
  sessionIdLocal: string,
): Promise<{ response: string; interrupts: InterruptExchange[] }> {
  const interrupts: InterruptExchange[] = [];
  let finished = false;

  const wrappedMain = mainTask.then((r) => { finished = true; return r; }).catch((e) => { finished = true; throw e; });

  const CANCEL_PATTERN = /^\s*(?:\/stop|\/cancel|stop|cancel|nevermind|abort)\s*$/i;
  let cancelled = false;

  const pollLoop = async () => {
    // 2s startup delay — skip polling overhead for very fast responses.
    await new Promise<void>((r) => setTimeout(r, 2000));
    while (!finished && !cancelled) {
      const messages = drainIpcInput();
      if (finished && messages.length === 0) break;
      for (const msg of messages) {
        // Immediate cancel: detect cancel commands in IPC input
        // Extract text from XML if present
        const textMatch = msg.match(/<message[^>]*>([\s\S]*?)<\/message>/);
        const rawText = textMatch ? textMatch[1].trim() : msg.trim();
        if (CANCEL_PATTERN.test(rawText)) {
          log('Cancel detected in IPC — aborting immediately');
          cancelled = true;
          writeOutput({ status: 'success', result: '_Stopped._', newSessionId: sessionIdLocal });
          setTimeout(() => process.exit(0), 100);
          return;
        }

        // Mid-task force escalation: (deep), (think), (coder) etc.
        const escalationTag = FORCE_ROUTE_TAGS.find((t) => t.pattern.test(rawText));
        if (escalationTag) {
          log(`Mid-task escalation via (${escalationTag.label}) — restarting at ${escalationTag.model}`);
          cancelled = true;
          writeOutput({ status: 'success', result: `_Escalating to ${escalationTag.label}..._`, newSessionId: sessionIdLocal });
          // Write the original prompt + escalation tag back to IPC input so it gets re-processed
          const requeueFile = path.join(IPC_INPUT_DIR, `escalate-${Date.now()}.json`);
          const tempPath = `${requeueFile}.tmp`;
          fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text: rawText }));
          fs.renameSync(tempPath, requeueFile);
          setTimeout(() => process.exit(0), 100);
          return;
        }

        const elapsed = Math.round((Date.now() - ctx.startedAt) / 1000);
        const phase = ctx.getPhase();
        const phaseLabel = phase.startsWith('tool:') ? phase.slice(5).replace(/_/g, ' ') : phase;
        const phaseNote = phaseLabel !== 'thinking' ? `, currently: ${phaseLabel}` : '';

        const systemCtx = `You are ${assistantNameLocal}, currently busy with a task: "${ctx.description.slice(0, 120)}" (${elapsed}s elapsed${phaseNote}). The user sent a message while you're working. Respond in 1-2 sentences only: give a status update if they're asking how it's going, or acknowledge their message and let them know you'll get to it after you finish. Do not pretend the current task is done.`;

        try {
          const quickReply = await callOllama(
            MODELS.SECRETARY,
            [
              { role: 'system', content: systemCtx },
              ...recentHistory.slice(-4),
              { role: 'user', content: msg },
            ],
            chatJid,
            groupFolder,
          );
          writeOutput({ status: 'success', result: `_[secretary]_ ${quickReply}`, newSessionId: sessionIdLocal });
          interrupts.push({ userMessage: msg, quickReply });
          log(`Quick response sent for mid-task message (${elapsed}s elapsed, phase: ${phaseLabel})`);
        } catch (err) {
          log(`Quick response failed: ${err instanceof Error ? err.message : String(err)}`);
          interrupts.push({ userMessage: msg, quickReply: '' });
        }
      }
      await new Promise<void>((r) => setTimeout(r, IPC_POLL_MS));
    }
  };

  const [response] = await Promise.all([wrappedMain, pollLoop()]);
  return { response, interrupts };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Input received for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const { chatJid, groupFolder, assistantName = 'Andy' } = containerInput;

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Stopped status is sent by the host (index.ts shutdown handler), not the container,
  // because docker kill sends SIGKILL — containers don't get a chance to write IPC files.
  process.once('SIGTERM', () => { process.exit(0); });
  process.once('SIGINT',  () => { process.exit(0); });

  // Read build ID baked in at deploy time

  // Send immediate "Starting..." notification
  const ipcMsgDir = IPC_MSG_DIR;
  const sendIpc = (filename: string, payload: Record<string, unknown>) => {
    try {
      fs.mkdirSync(ipcMsgDir, { recursive: true });
      fs.writeFileSync(path.join(ipcMsgDir, filename), JSON.stringify({ ...payload, buildId }));
    } catch (err) { log(`IPC write failed (${filename}): ${err instanceof Error ? err.message : String(err)}`); }
  };
  // Deferred init: runs after first response so it doesn't compete with the first Ollama call
  let initDone = false;
  let ollamaOnline = false;
  let comfyOnline = false;
  let odOnline = false;

  const COMFYUI_HOST = process.env.COMFYUI_HOST || 'http://host.docker.internal:8000';
  const OLLAMADIFFUSER_HOST = process.env.OLLAMADIFFUSER_HOST || 'http://host.docker.internal:8001';
  const HEALTH_POLL_MS = 15_000;

  const startBackgroundInit = () => {
    if (initDone) return;
    initDone = true;

    // Health-check loop — notifies on state transitions only
    const makeServiceMonitor = (
      name: string,
      check: () => Promise<boolean>,
      initialState: boolean,
      onDown: string,
      onUp: string,
    ) => {
      let state = initialState;
      const poll = async () => {
        try {
          const nowOnline = await check();
          if (nowOnline !== state) {
            state = nowOnline;
            const text = nowOnline ? onUp : onDown;
            if (text) sendIpc(`health-${Date.now()}.json`, { type: 'message', chatJid, text });
            log(`${name} state changed: ${nowOnline ? 'online' : 'offline'}`);
          }
        } catch {
          if (state) {
            state = false;
            sendIpc(`health-${Date.now()}.json`, { type: 'message', chatJid, text: onDown });
            log(`${name} became unreachable`);
          }
        }
        setTimeout(poll, HEALTH_POLL_MS);
      };
      setTimeout(poll, HEALTH_POLL_MS);
    };

    (async () => {
      // Check whether the container build succeeded at startup — warn immediately if stale image
      try {
        const buildStatusFile = `${WORKSPACE_PROJECT}/.build-status.json`;
        if (fs.existsSync(buildStatusFile)) {
          const bs = JSON.parse(fs.readFileSync(buildStatusFile, 'utf-8')) as { status: string; at: string };
          if (bs.status === 'failed') {
            sendIpc(`build-fail-${Date.now()}.json`, {
              type: 'message',
              chatJid,
              text: `⚠️ _Container build failed at ${bs.at} — running stale image. Check logs/ for details._`,
            });
          }
        }
      } catch { /* best effort */ }

      try {
        const ollamaCheck = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
        ollamaOnline = ollamaCheck.ok;
        if (!ollamaOnline) {
          sendIpc(`startup-${Date.now()}.json`, { type: 'status', chatJid, text: `_${assistantName} offline — Ollama is not running._` });
          return;
        }
      } catch {
        sendIpc(`startup-${Date.now()}.json`, { type: 'status', chatJid, text: `_${assistantName} offline — Ollama is not running._` });
        return;
      }

      // Online status is sent by the host (index.ts) after bot init — not from the container.
      // This avoids the race where IPC arrives before the bot can send/pin.

      // Warm both models — secretary for classify/translate, coordinator for inference.
      // Small num_ctx to avoid VRAM eviction. Host warm script already loaded both;
      // this just ensures keep_alive is set from the container's perspective.
      for (const wm of [MODELS.SECRETARY, MODELS.COORDINATOR]) {
        fetch(`${OLLAMA_HOST}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: wm, messages: [{ role: 'user', content: '' }], keep_alive: KEEP_ALIVE_PINNED, options: { num_predict: 0, num_ctx: 512 }, stream: false }),
        }).then(() => log(`${wm} warmed`)).catch(() => {});
      }

      makeServiceMonitor(
        'Ollama',
        async () => { const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) }); return r.ok; },
        ollamaOnline,
        `_${assistantName} offline — Ollama became unreachable._`,
        `_${assistantName} back online — Ollama reconnected._`,
      );
      makeServiceMonitor(
        'ComfyUI',
        async () => { const r = await fetch(`${COMFYUI_HOST}/system_stats`, { signal: AbortSignal.timeout(5000) }); return r.ok; },
        comfyOnline,
        `_ComfyUI went offline._`,
        ``,
      );
      makeServiceMonitor(
        'OllamaDiffuser',
        async () => { const r = await fetch(`${OLLAMADIFFUSER_HOST}/api/models`, { signal: AbortSignal.timeout(5000) }); return r.ok; },
        odOnline,
        `_OllamaDiffuser went offline._`,
        ``,
      );

      // Check video backends once — no polling. If not available now, report and move on.
      const [comfyModels, odModels] = await Promise.all([
        listComfyVideoModels().catch(() => [] as string[]),
        listOllamaDiffuserVideoModels().catch(() => [] as string[]),
      ]);
      comfyOnline = comfyModels.length > 0;
      odOnline = odModels.length > 0;

      const failures: string[] = [];
      if (!comfyOnline) failures.push('ComfyUI');
      if (!odOnline) failures.push('OllamaDiffuser');
      if (failures.length > 0) {
        log(`Backends not available: ${failures.join(', ')}`);
        sendIpc(`backend-warn-${Date.now()}.json`, {
          type: 'message', chatJid,
          text: `⚠️ _${failures.join(', ')} not available — image/video generation may be limited._`,
        });
      }
    })().catch(() => { /* ignore */ });
  };

  // Start health monitors and backend checks immediately — runs concurrently
  // with the first Ollama call so init is done by the time the user sends a follow-up.
  startBackgroundInit();

  let history = loadHistory();
  const sessionId = containerInput.sessionId || `ollama-${Date.now()}`;

  let prompt: string;
  if (containerInput.prespin) {
    // Pre-spawn mode: init is already running, just wait for the first real message via IPC.
    log('Pre-spawned and ready, waiting for first message...');
    const firstMessage = await waitForIpcMessage();
    if (firstMessage === null) {
      log('Pre-spawn closed before first message received');
      process.exit(0);
    }
    prompt = firstMessage;
  } else {
    prompt = containerInput.prompt;
    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK]\n\n${prompt}`;
    }
    if (containerInput.images?.length) {
      prompt = `[${containerInput.images.length} image(s) attached]\n${prompt}`;
    }
    // Inform model of available video context for generation
    if (hasReferenceVideo()) {
      prompt = `[Reference video available — first frame will be used for image-to-video generation]\n${prompt}`;
    }
    const pending = drainIpcInput();
    if (pending.length > 0) {
      prompt += '\n' + pending.join('\n');
    }
  }

  // Images from the incoming message (0, 1, or multiple)
  // Only used on the first turn; cleared after so follow-up messages don't re-attach them
  let currentImages: string[] | undefined = containerInput.images?.length
    ? containerInput.images
    : undefined;

  // Persist received images so follow-up edit requests (sent as separate messages) can find them
  if (currentImages?.length) {
    saveLatestImage(currentImages);
  }

  const systemMsg: Message = { role: 'system', content: getSystemPrompt(assistantName, groupFolder) };

  // Background compression: runs during waitForIpcMessage so it doesn't block inference.
  // compressedHistory is applied at the start of the next turn if ready.
  let compressedHistory: Message[] | null = null;

  try {
    while (true) {
      // Apply background compression from previous turn if complete
      if (compressedHistory !== null) {
        history = compressedHistory;
        compressedHistory = null;
      }

      // Per-user response queuing: when multiple users send messages in the
      // same batch, process each sender separately to prevent cross-wiring.
      const senderGroups = splitBySender(prompt);
      if (senderGroups.length > 1) {
        log(`Multi-sender batch: ${senderGroups.map((g) => g.sender).join(', ')} — processing sequentially`);
      }

      for (const senderGroup of senderGroups) {
        if (senderGroups.length > 1) {
          prompt = senderGroup.prompt;
          log(`Processing messages from: ${senderGroup.sender} (${prompt.length} chars)`);
        }

      const cls = await classifyMessage(prompt, !!currentImages?.length);

      // Send status indicator after classification (one message, no doubles)
      const ackId = `ack-${Date.now()}`;
      fs.mkdirSync(IPC_MSG_DIR, { recursive: true });
      const { model, think: thinking, taskType, taskTypeRich, temperature } = cls;
      log(`Model: ${model} think=${thinking} task=${taskTypeRich} complexity=${cls.complexity} prompt_len=${prompt.length}${currentImages ? ` images=${currentImages.length}` : ''}`);

      // Text translations are handled on the host side (telegram.ts) using
      // the same translateToMultiple path as voice messages, for consistent UX.

      // Secretary direct execution: simple queries bypass the coordinator
      // (noskip) tag forces full coordinator path — no shortcuts
      const noSkip = /\(noskip\)/i.test(prompt);
      const directResult = noSkip ? null : await trySecretaryDirect(prompt, cls, chatJid, groupFolder);
      if (directResult) {
        const userMsg: Message = { role: 'user', content: prompt };
        history = [...history, userMsg, { role: 'assistant', content: directResult }];
        saveHistory(history);
        writeOutput({ status: 'success', result: directResult, newSessionId: sessionId });
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
        continue; // skip coordinator, go to next sender or wait for IPC
      }

      const userMsg: Message = { role: 'user', content: prompt };
      // Inject routing hint — zero-inference classification that primes the coordinator
      // to delegate, search, or enable thinking before starting inference
      const routeHint = buildRouteHint(prompt, !!currentImages?.length);
      const routeMsg: Message = { role: 'system', content: routeHint };
      // Hard-cap history to prevent Ollama inference hangs on large contexts
      const safeHistory = trimHistoryForInference(history);
      const messages = [systemMsg, ...safeHistory, userMsg, routeMsg];

      // Progressive status indicator using the "..." ack message:
      // 1. "..." already sent (ackId) — shows message was received
      // 2. Update with model/task after classification
      // 3. Update with elapsed time during inference
      // 4. Delete on completion — stats appended to the actual response
      let statusLabel = getStatusLabel(model, thinking);
      let responseType = currentImages?.length ? 'vision'
        : taskTypeRich === 'code' || taskTypeRich === 'debug' ? 'coding'
        : taskTypeRich === 'creative' ? 'creative'
        : taskTypeRich === 'research' ? 'research'
        : taskTypeRich === 'decision' ? 'decision'
        : thinking ? 'reasoning'
        : 'chat';
      const modelLabel = thinking ? `${model}+think` : model;
      let elapsedSeconds = 0;
      const statusFiles: string[] = [];

      // Single status message with model/task info (sent after classification, ~300ms)
      fs.writeFileSync(
        path.join(IPC_MSG_DIR, `${ackId}-start.json`),
        JSON.stringify({ type: 'thinking_start', chatJid, text: `_${modelLabel} · ${responseType}_`, thinkingId: ackId }),
      );

      let thinkingInterval: ReturnType<typeof setInterval> | null = null;

      const setStatus = (text: string) => {
        if (/generating\s+image/i.test(text)) { statusLabel = 'Processing'; responseType = 'image'; }
        if (/generating\s+video/i.test(text)) { statusLabel = 'Processing'; responseType = 'video'; }
        elapsedSeconds += 5;
        const f = path.join(IPC_MSG_DIR, `${ackId}-upd-${String(elapsedSeconds).padStart(5, '0')}.json`);
        statusFiles.push(f);
        fs.writeFileSync(f, JSON.stringify({
          type: 'thinking_update', chatJid, thinkingId: ackId,
          text: `_${modelLabel} · ${responseType} — ${text}_`,
        }));
      };

      // After 5s, start showing elapsed time
      const thinkingDelay = setTimeout(() => {
        elapsedSeconds = 5;
        setStatus(`${statusLabel}... (${elapsedSeconds}s)`);
        thinkingInterval = setInterval(() => {
          elapsedSeconds += 5;
          setStatus(`${statusLabel}... (${elapsedSeconds}s)`);
        }, 5000);
      }, 5000);

      // On completion: delete the status message (stats go in the response itself)
      const clearThinking = () => {
        clearTimeout(thinkingDelay);
        if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
        for (const f of statusFiles) { try { fs.unlinkSync(f); } catch { /* already read */ } }
        statusFiles.length = 0;
        // Delete the status message from chat (zzz prefix sorts after start/upd files)
        fs.writeFileSync(
          path.join(IPC_MSG_DIR, `${ackId}-zzz-clear.json`),
          JSON.stringify({ type: 'thinking_clear', thinkingId: ackId }),
        );
      };

      // Let the model drive the conversation.
      // A concurrent poller runs alongside the inference so messages sent while Jarvis
      // is busy get an immediate brief response via qwen3.5:35b.
      const responseStart = Date.now();
      const taskPhaseRef = { value: 'thinking' };
      const callPromise = callOllama(
        model, messages, chatJid, groupFolder, currentImages, temperature, setStatus, thinking,
        (toolName) => { taskPhaseRef.value = `tool:${toolName}`; }, cls.complexity,
      );
      const taskCtx: TaskContext = {
        description: prompt.slice(0, 120).replace(/\n/g, ' '),
        getPhase: () => taskPhaseRef.value,
        startedAt: responseStart,
      };
      const { response, interrupts } = await runWithConcurrentPoll(
        callPromise, taskCtx, chatJid, groupFolder, history, assistantName, sessionId,
      );
      const responseMs = Date.now() - responseStart;
      clearThinking();
      currentImages = undefined; // images consumed after first call
      log(`[PERF] response | model=${model} | task=${taskType} | think=${thinking} | prompt_chars=${prompt.length} | history_msgs=${history.length} | total_ms=${responseMs}${interrupts.length > 0 ? ` | mid_task_interrupts=${interrupts.length}` : ''}`);
      const wasDissatisfied = detectDissatisfaction(prompt);
      // PM-008: Feed user dissatisfaction back to secretary routing
      if (wasDissatisfied && cls.usedSecretary) {
        appendSecretaryFeedback({
          at: Date.now(),
          promptPreview: prompt.slice(0, 80),
          routingGrade: 'wrong',
          routingNote: `user dissatisfied — was routed to ${model} (${taskTypeRich})`,
        });
      }
      logPerf({
        type: 'response', buildId, timestamp: new Date().toISOString(),
        model, think: thinking, taskType, complexity: cls.complexity,
        promptChars: prompt.length, responseChars: response.length,
        responseMs, historyMsgs: history.length,
        ...(wasDissatisfied ? { dissatisfied: true } : {}),
      });
      if (wasDissatisfied) {
        logPerf({ type: 'escalation', buildId, timestamp: new Date().toISOString(), reason: 'user_dissatisfaction' });
      }

      // <silent/> — model chose not to respond. Add to history but don't output.
      const isSilent = response.trim() === '<silent/>' || response.trim() === '<silent>';
      if (isSilent) {
        log('Model chose <silent/> — not responding');
        history = [...history, userMsg];
        saveHistory(history);
        // Still need to clear thinking and write null output for session tracking
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
        continue;
      }

      history = [...history, userMsg, { role: 'assistant', content: response }];
      // Inject any mid-task exchanges into history so the next turn has full context
      for (const ex of interrupts) {
        if (ex.quickReply) {
          history = [...history,
            { role: 'user', content: ex.userMessage },
            { role: 'assistant', content: ex.quickReply },
          ];
        }
      }
      // Send response FIRST — never let compression block the user
      const statsLine = `\n\n_(${model.replace(/:.*/, '')}${thinking ? '+think' : ''} · ${taskTypeRich} · ${(responseMs / 1000).toFixed(1)}s)_`;
      const responseWithStats = response ? response + statsLine : null;

      writeOutput({
        status: 'success',
        result: responseWithStats,
        newSessionId: sessionId,
      });

      saveHistory(history);

      // Compress history — always background, never blocks response
      const { compressThreshold, keepRecent } = getHistoryConfig(model, thinking);
      if (history.length > compressThreshold) {
        compressHistory(history, compressThreshold, keepRecent)
          .then((h) => { compressedHistory = h; saveHistory(h); })
          .catch(() => {});
      }

      // Response translations handled on host side (reply-to the sent message)

      // Session-update marker so host tracks the session
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      } // end per-sender loop

      log('Waiting for next message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Next message: ${nextMessage.length} chars`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Error: ${errorMessage}`);
    // Classify error for PM-005 taxonomy
    const errCategory = errorMessage.includes('timed out') || errorMessage.includes('ECONNREFUSED') ? 'environmental'
      : errorMessage.includes('parse') || errorMessage.includes('JSON') ? 'data_state'
      : errorMessage.includes('ENOENT') || errorMessage.includes('permission') ? 'environmental'
      : 'code';
    logPerf({ type: 'error', buildId, timestamp: new Date().toISOString(), category: errCategory, error: errorMessage.slice(0, 200) });
    // Send error to chat so it never fails silently
    try {
      const ipcFile = path.join(IPC_MSG_DIR, `err-${Date.now()}.json`);
      fs.mkdirSync(IPC_MSG_DIR, { recursive: true });
      fs.writeFileSync(ipcFile, JSON.stringify({ type: 'message', chatJid, text: `⚠️ Error: ${errorMessage}` }));
    } catch { /* best effort */ }
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
