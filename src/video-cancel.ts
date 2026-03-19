/**
 * Cancel in-flight video generation jobs on the host backends.
 * Called when the user sends a cancel command while a container is active.
 *
 * - ComfyUI:        POST /interrupt — stops the currently running workflow.
 *                   Safe to call when idle (no-op). ComfyUI processes jobs
 *                   asynchronously, so killing the container doesn't stop it.
 *
 * - OllamaDiffuser: No action needed. Killing the container drops the HTTP
 *                   connection; OllamaDiffuser will detect the disconnect and
 *                   stop. We never kill/restart it here to avoid disrupting
 *                   healthy idle instances.
 */

import { logger } from './logger.js';

const COMFYUI_HOST = process.env.COMFYUI_HOST || 'http://127.0.0.1:8000';

/**
 * Cancel all in-flight video generation.
 * Fire-and-forget — errors are logged but not thrown.
 */
export async function cancelVideoBackends(): Promise<void> {
  try {
    const resp = await fetch(`${COMFYUI_HOST}/interrupt`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      logger.info('ComfyUI interrupted');
    }
  } catch {
    // ComfyUI might not be running — ignore
  }
}
