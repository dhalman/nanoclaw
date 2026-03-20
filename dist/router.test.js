import { describe, expect, it, vi } from 'vitest';
import { findChannel, formatOutbound, routeOutbound, stripInternalTags, } from './router.js';
function makeChannel(name, jidPrefix, connected = true) {
    return {
        name,
        connect: vi.fn(async () => { }),
        sendMessage: vi.fn(async () => { }),
        isConnected: () => connected,
        ownsJid: (jid) => jid.startsWith(jidPrefix),
        disconnect: vi.fn(async () => { }),
    };
}
// --- stripInternalTags ---
describe('stripInternalTags', () => {
    it('strips single internal block', () => {
        expect(stripInternalTags('before<internal>secret</internal>after')).toBe('beforeafter');
    });
    it('strips multiple internal blocks', () => {
        expect(stripInternalTags('a<internal>x</internal>b<internal>y</internal>c')).toBe('abc');
    });
    it('strips multiline internal blocks', () => {
        expect(stripInternalTags('hello<internal>\nline1\nline2\n</internal>world')).toBe('helloworld');
    });
    it('returns trimmed text when no internal tags', () => {
        expect(stripInternalTags('  hello world  ')).toBe('hello world');
    });
    it('returns empty string when only internal content', () => {
        expect(stripInternalTags('<internal>all hidden</internal>')).toBe('');
    });
});
// --- formatOutbound ---
describe('formatOutbound', () => {
    it('strips internal tags and returns text', () => {
        expect(formatOutbound('Hello<internal>reasoning</internal> world')).toBe('Hello world');
    });
    it('returns empty string when all content is internal', () => {
        expect(formatOutbound('<internal>only reasoning</internal>')).toBe('');
    });
    it('returns empty string for whitespace-only after stripping', () => {
        expect(formatOutbound('<internal>x</internal>   ')).toBe('');
    });
});
// --- findChannel ---
describe('findChannel', () => {
    const channels = [
        makeChannel('whatsapp', '@'),
        makeChannel('telegram', 'tg:'),
    ];
    it('finds channel that owns the JID', () => {
        const ch = findChannel(channels, 'tg:12345');
        expect(ch?.name).toBe('telegram');
    });
    it('returns undefined for unknown JID', () => {
        expect(findChannel(channels, 'dc:12345')).toBeUndefined();
    });
    it('returns first matching channel', () => {
        const ch = findChannel(channels, '@12345');
        expect(ch?.name).toBe('whatsapp');
    });
});
// --- routeOutbound ---
describe('routeOutbound', () => {
    it('sends message to correct channel', async () => {
        const tg = makeChannel('telegram', 'tg:');
        await routeOutbound([tg], 'tg:123', 'hello');
        expect(tg.sendMessage).toHaveBeenCalledWith('tg:123', 'hello');
    });
    it('throws when no channel matches', () => {
        const tg = makeChannel('telegram', 'tg:');
        expect(() => routeOutbound([tg], 'dc:123', 'hello')).toThrow('No channel for JID');
    });
    it('skips disconnected channels', () => {
        const tg = makeChannel('telegram', 'tg:', false);
        expect(() => routeOutbound([tg], 'tg:123', 'hello')).toThrow('No channel for JID');
    });
});
//# sourceMappingURL=router.test.js.map