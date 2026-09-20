import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { appendFileContent, applyFileEdits, writeFileContent } from '../lib.js';

const createdDirectories: string[] = [];

async function makeTestDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-filesystem-downstream-'));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('downstream existing-file writes', () => {
  it('preserves inode and mode when writeFileContent replaces content', async () => {
    const directory = await makeTestDirectory();
    const file = path.join(directory, 'file.txt');
    await fs.writeFile(file, 'before', { mode: 0o640 });
    const before = await fs.stat(file);

    await writeFileContent(file, 'after');

    const after = await fs.stat(file);
    expect(await fs.readFile(file, 'utf-8')).toBe('after');
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
  });

  it('appends exact UTF-8 bytes at physical EOF while preserving inode and mode', async () => {
    const directory = await makeTestDirectory();
    const file = path.join(directory, 'append.log');
    await fs.writeFile(file, 'prefix\nrepeat\nrepeat\n', { mode: 0o640 });
    const before = await fs.stat(file);

    const result = await appendFileContent(file, 'repeat\nΩ\n');

    const after = await fs.stat(file);
    expect(await fs.readFile(file, 'utf-8')).toBe('prefix\nrepeat\nrepeat\nrepeat\nΩ\n');
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(result.bytesAppended).toBe(Buffer.byteLength('repeat\nΩ\n', 'utf-8'));
    expect(result.postSize).toBe(after.size);
    expect(result.tailCheck.matches).toBe(true);
    expect(result.tailCheck.bytes).toBe(result.bytesAppended);
    expect(result.tailCheck.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves inode and mode when applyFileEdits writes an edit', async () => {
    const directory = await makeTestDirectory();
    const file = path.join(directory, 'file.txt');
    await fs.writeFile(file, 'line1\nline2\n', { mode: 0o640 });
    const before = await fs.stat(file);

    await applyFileEdits(file, [{ oldText: 'line2', newText: 'changed' }], false);

    const after = await fs.stat(file);
    expect(await fs.readFile(file, 'utf-8')).toBe('line1\nchanged\n');
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
  });

  it('does not follow an existing symlink during writeFileContent', async () => {
    const directory = await makeTestDirectory();
    const target = path.join(directory, 'target.txt');
    const link = path.join(directory, 'link.txt');
    await fs.writeFile(target, 'protected');
    await fs.symlink(target, link);

    await expect(writeFileContent(link, 'replacement')).rejects.toThrow();
    expect(await fs.readFile(target, 'utf-8')).toBe('protected');
  });
});
