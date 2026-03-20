import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelVideoBackends } from './video-cancel.js';
describe('cancelVideoBackends', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('does not throw when ComfyUI is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
        await expect(cancelVideoBackends()).resolves.toBeUndefined();
    });
    it('calls POST /interrupt on ComfyUI', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);
        await cancelVideoBackends();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('/interrupt');
        expect(opts.method).toBe('POST');
    });
    it('does not throw on non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
        await expect(cancelVideoBackends()).resolves.toBeUndefined();
    });
});
//# sourceMappingURL=video-cancel.test.js.map