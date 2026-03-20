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
export declare function loadReferenceImages(): string[] | null;
export declare function generateImageComfyUI(prompt: string): Promise<{
    buffer: Buffer;
    model: string;
}>;
export declare function generateImageOllamaDiffuser(prompt: string, refImageBase64?: string): Promise<{
    buffer: Buffer;
    model: string;
}>;
export declare function generateImageOllama(model: string, prompt: string): Promise<{
    buffer: Buffer;
    model: string;
}>;
export declare function enhancePrompt(prompt: string): Promise<string>;
export declare function describeImages(images: string[]): Promise<string[]>;
export type ImageBackend = 'comfyui' | 'ollamadiffuser' | 'ollama' | 'auto';
export declare function generateImage(ollamaModel: string, prompt: string, backend?: ImageBackend, options?: {
    useReference?: boolean;
    embellish?: boolean;
}): Promise<{
    buffer: Buffer;
    source: string;
}>;
