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
/**
 * Cancel all in-flight video generation.
 * Fire-and-forget — errors are logged but not thrown.
 */
export declare function cancelVideoBackends(): Promise<void>;
//# sourceMappingURL=video-cancel.d.ts.map