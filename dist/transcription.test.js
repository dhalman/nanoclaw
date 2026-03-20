import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
// --- Mocks ---
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));
const fsMock = vi.hoisted(() => ({
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
}));
vi.mock('fs', () => ({ default: fsMock }));
vi.mock('./logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn() },
}));
import { transcribeAudio } from './transcription.js';
function makeChild(stdout = '', exitCode = 0, stderr = '') {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    process.nextTick(() => {
        if (stdout)
            child.stdout.emit('data', Buffer.from(stdout));
        if (stderr)
            child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', exitCode);
    });
    return child;
}
function makeHangingChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
        // Simulate kill triggering close with non-zero code
        process.nextTick(() => child.emit('close', 1));
    });
    return child;
}
// --- Tests ---
describe('transcribeAudio', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        spawnMock.mockImplementation(() => makeChild(JSON.stringify({
            text: 'Hello world',
            language: 'en',
            language_probability: 0.98,
        }), 0));
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('returns transcript on successful transcription', async () => {
        spawnMock.mockImplementationOnce(() => makeChild(JSON.stringify({
            text: 'Hello world',
            language: 'en',
            language_probability: 0.98,
        }), 0));
        const result = await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(result).toEqual({
            text: 'Hello world',
            language: 'en',
            languageProbability: 0.98,
        });
    });
    it('trims whitespace from JSON output', async () => {
        spawnMock.mockImplementationOnce(() => makeChild('  ' +
            JSON.stringify({
                text: 'hello world',
                language: 'en',
                language_probability: 0.95,
            }) +
            '\n', 0));
        const result = await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(result).toEqual({
            text: 'hello world',
            language: 'en',
            languageProbability: 0.95,
        });
    });
    it('returns null when process exits with non-zero code', async () => {
        spawnMock.mockImplementationOnce(() => makeChild('', 1, 'some error'));
        const result = await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(result).toBeNull();
    });
    it('returns null when stdout is empty', async () => {
        spawnMock.mockImplementationOnce(() => makeChild('', 0));
        const result = await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(result).toBeNull();
    });
    it('returns null when stdout is only whitespace', async () => {
        spawnMock.mockImplementationOnce(() => makeChild('   \n  ', 0));
        const result = await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(result).toBeNull();
    });
    it('returns null when spawn emits an error', async () => {
        const child = makeHangingChild();
        spawnMock.mockImplementationOnce(() => {
            process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
            return child;
        });
        const result = await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(result).toBeNull();
    });
    it('returns null and kills process on timeout', async () => {
        vi.useFakeTimers();
        const child = makeHangingChild();
        spawnMock.mockImplementationOnce(() => child);
        const promise = transcribeAudio(Buffer.from('audio'), 'ogg');
        vi.advanceTimersByTime(60_001);
        const result = await promise;
        expect(result).toBeNull();
        expect(child.kill).toHaveBeenCalled();
    });
    it('always cleans up temp file on success', async () => {
        spawnMock.mockImplementationOnce(() => makeChild(JSON.stringify({
            text: 'transcript',
            language: 'en',
            language_probability: 0.9,
        }), 0));
        await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    });
    it('always cleans up temp file on failure', async () => {
        spawnMock.mockImplementationOnce(() => makeChild('', 1));
        await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    });
    it('writes audio buffer to temp file before spawning', async () => {
        const buf = Buffer.from([1, 2, 3, 4]);
        spawnMock.mockImplementationOnce(() => makeChild(JSON.stringify({
            text: 'ok',
            language: 'en',
            language_probability: 0.9,
        }), 0));
        await transcribeAudio(buf, 'ogg');
        expect(fsMock.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('nanoclaw-voice-'), buf);
    });
    it('uses the provided extension in the temp filename', async () => {
        spawnMock.mockImplementationOnce(() => makeChild(JSON.stringify({
            text: 'ok',
            language: 'en',
            language_probability: 0.9,
        }), 0));
        await transcribeAudio(Buffer.from('audio'), 'mp3');
        expect(fsMock.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/), expect.anything());
    });
    it('passes the temp file path to the Python script', async () => {
        spawnMock.mockImplementationOnce(() => makeChild(JSON.stringify({
            text: 'ok',
            language: 'en',
            language_probability: 0.9,
        }), 0));
        await transcribeAudio(Buffer.from('audio'), 'ogg');
        const [, args] = spawnMock.mock.calls[0];
        expect(args[1]).toMatch(/nanoclaw-voice-.*\.ogg$/);
    });
    it('accumulates stdout across multiple data chunks', async () => {
        const json = JSON.stringify({
            text: 'Hello world',
            language: 'en',
            language_probability: 0.99,
        });
        const mid = Math.floor(json.length / 2);
        const child = makeHangingChild();
        spawnMock.mockImplementationOnce(() => {
            process.nextTick(() => {
                child.stdout.emit('data', Buffer.from(json.slice(0, mid)));
                child.stdout.emit('data', Buffer.from(json.slice(mid)));
                child.emit('close', 0);
            });
            return child;
        });
        const result = await transcribeAudio(Buffer.from('audio'), 'ogg');
        expect(result).toEqual({
            text: 'Hello world',
            language: 'en',
            languageProbability: 0.99,
        });
    });
});
//# sourceMappingURL=transcription.test.js.map