import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sandbox, UserError } from '../src/core/paths.js';

let root: string;
let outside: string;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-root-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-out-')));
  await fs.writeFile(path.join(root, 'a.png'), 'x');
  await fs.writeFile(path.join(outside, 'secret.png'), 'x');
  if (process.platform !== 'win32') await fs.symlink(path.join(outside, 'secret.png'), path.join(root, 'link.png'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('Sandbox', () => {
  it('resolves relative paths against the first allowed directory', async () => {
    const sb = await Sandbox.create([root]);
    expect(sb.absolute('a.png')).toBe(path.join(root, 'a.png'));
    expect(await sb.existing('a.png')).toBe(path.join(root, 'a.png'));
  });

  // Windows runners need admin rights to create file symlinks.
  it.skipIf(process.platform === 'win32')('refuses paths outside, "..", symlink escapes and null bytes', async () => {
    const sb = await Sandbox.create([root]);
    await expect(sb.existing(path.join(outside, 'secret.png'))).rejects.toThrow(UserError);
    await expect(sb.existing('../' + path.basename(outside) + '/secret.png')).rejects.toThrow(UserError);
    await expect(sb.existing('link.png')).rejects.toThrow(UserError);
    expect(() => sb.absolute('a\0.png')).toThrow(UserError);
  });

  it('allows new output paths inside and refuses them outside', async () => {
    const sb = await Sandbox.create([root]);
    expect(await sb.writable('optimized/deep/x.avif')).toBe(path.join(root, 'optimized/deep/x.avif'));
    await expect(sb.writable(path.join(outside, 'x.avif'))).rejects.toThrow(UserError);
  });

  it('falls back to the project folder, but never the home folder or a root', async () => {
    expect((await Sandbox.fromStartup([], root)).roots).toEqual([root]);
    expect((await Sandbox.fromStartup([], os.homedir())).roots).toEqual([]);
    expect((await Sandbox.fromStartup([], '/')).roots).toEqual([]);
    await expect((await Sandbox.fromStartup([], undefined)).existing('a.png')).rejects.toThrow(/No allowed directories/);
  });
});
