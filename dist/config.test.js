import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME, CANCEL_PATTERN, DISMISS_PATTERN, TRIGGER_PATTERN, } from './config.js';
describe('TRIGGER_PATTERN', () => {
    const test = (text) => TRIGGER_PATTERN.test(text);
    it('matches direct address: "Jarvis, help"', () => {
        expect(test(`${ASSISTANT_NAME}, help me`)).toBe(true);
    });
    it('matches greeting + name: "hi Jarvis"', () => {
        expect(test(`hi ${ASSISTANT_NAME}`)).toBe(true);
    });
    it('matches greeting + name: "hey Jarvis"', () => {
        expect(test(`hey ${ASSISTANT_NAME}`)).toBe(true);
    });
    it('matches name at start: "Jarvis hello"', () => {
        expect(test(`${ASSISTANT_NAME} hello`)).toBe(true);
    });
    it('matches @mention: "@Jarvis"', () => {
        expect(test(`@${ASSISTANT_NAME}`)).toBe(true);
    });
    it('does not match name in middle of sentence', () => {
        expect(test(`I told ${ASSISTANT_NAME} about it`)).toBe(false);
    });
    it('is case insensitive', () => {
        expect(test(`${ASSISTANT_NAME.toLowerCase()}, help`)).toBe(true);
    });
});
describe('DISMISS_PATTERN', () => {
    const test = (text) => DISMISS_PATTERN.test(text);
    it('matches "bye"', () => expect(test('bye')).toBe(true));
    it('matches "goodbye"', () => expect(test('goodbye')).toBe(true));
    it('matches "no thanks"', () => expect(test('no thanks')).toBe(true));
    it('matches "nah"', () => expect(test('nah')).toBe(true));
    it('matches "that\'s all"', () => expect(test("that's all")).toBe(true));
    it('matches "enough"', () => expect(test('enough')).toBe(true));
    it('matches "👋"', () => expect(test('👋')).toBe(true));
    it('does not match mid-sentence', () => {
        expect(test('bye the way this is great')).toBe(false);
    });
    it('is case insensitive', () => expect(test('BYE')).toBe(true));
});
describe('CANCEL_PATTERN', () => {
    const test = (text) => CANCEL_PATTERN.test(text);
    it('matches "/stop"', () => expect(test('/stop')).toBe(true));
    it('matches "/cancel"', () => expect(test('/cancel')).toBe(true));
    it('matches "stop"', () => expect(test('stop')).toBe(true));
    it('matches "cancel"', () => expect(test('cancel')).toBe(true));
    it('matches "nevermind"', () => expect(test('nevermind')).toBe(true));
    it('does not match "stop talking about it"', () => {
        expect(test('stop talking about it')).toBe(false);
    });
});
//# sourceMappingURL=config.test.js.map