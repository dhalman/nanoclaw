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
/** Load the most recently saved images (from user's photo messages). */
export declare function loadReferenceImages(): string[] | null;
/**
 * Returns reference image(s) as base64 strings for use in I2I generation.
 * Priority: saved photos → first frame of reference video.
 * Returns null if no fresh context exists.
 */
export declare function getReferenceImages(): string[] | null;
/** Check whether a reference video exists and is fresh. */
export declare function hasReferenceVideo(): boolean;
/** Return combined labels for ComfyUI video checkpoints that are installed, merging T2V/I2V modes. */
export declare function listComfyVideoModels(): Promise<string[]>;
export declare function generateVideoComfyUI(prompt: string, refImageBuffers?: Buffer[]): Promise<{
    buffer: Buffer;
    label: string;
}>;
/** Return all model names reported by OllamaDiffuser. Empty array if unavailable. */
export declare function listOllamaDiffuserModels(): Promise<string[]>;
/** Return combined labels for OllamaDiffuser video models. All support T2V + I2V (image is optional). */
export declare function listOllamaDiffuserVideoModels(): Promise<string[]>;
export declare function generateVideoOllamaDiffuser(prompt: string, refImageBase64?: string): Promise<{
    buffer: Buffer;
    label: string;
}>;
export type VideoBackend = 'comfyui' | 'ollamadiffuser' | 'auto';
export declare function generateVideo(prompt: string, backend?: VideoBackend, options?: {
    useReference?: boolean;
}): Promise<{
    buffer: Buffer;
    source: string;
    usedContext: string;
    effectivePrompt: string;
}>;
