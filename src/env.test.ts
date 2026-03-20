import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from './env.js';

let origCwd: string;
let tmpDir: string;

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readEnvFile', () => {
  it('returns empty object when .env does not exist', () => {
    expect(readEnvFile(['FOO'])).toEqual({});
  });

  it('reads requested keys', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\nBAZ=qux\n');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar' });
  });

  it('ignores unrequested keys', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\nBAZ=qux\n');
    expect(readEnvFile(['BAZ'])).toEqual({ BAZ: 'qux' });
  });

  it('strips double quotes from values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO="hello world"\n');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'hello world' });
  });

  it('strips single quotes from values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), "FOO='hello world'\n");
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'hello world' });
  });

  it('skips comments and blank lines', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      '# comment\n\nFOO=bar\n  # another\nBAZ=qux\n',
    );
    expect(readEnvFile(['FOO', 'BAZ'])).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles values with equals signs', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'URL=https://a.com?x=1&y=2\n');
    expect(readEnvFile(['URL'])).toEqual({ URL: 'https://a.com?x=1&y=2' });
  });

  it('skips empty values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=\nBAR=val\n');
    expect(readEnvFile(['FOO', 'BAR'])).toEqual({ BAR: 'val' });
  });

  it('handles lines without equals sign', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'NOEQ\nFOO=bar\n');
    expect(readEnvFile(['NOEQ', 'FOO'])).toEqual({ FOO: 'bar' });
  });

  it('trims whitespace around key and value', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '  FOO  =  bar  \n');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'bar' });
  });
});
