import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { Sandbox, UserError, toPosix } from './paths.js';

export const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff']);
/** Recognised but not handled in v1, with the reason given back to the agent. */
const REFUSED_EXTENSIONS: Record<string, string> = {
  '.heic': 'HEIC is not supported yet (sharp cannot decode HEVC). Convert it to JPEG first.',
  '.heif': 'HEIF/HEIC is not supported yet (sharp cannot decode HEVC). Convert it to JPEG first.',
  '.svg': 'SVG is vector; it is left as is (SVG optimisation is planned for a later version).',
  '.bmp': 'BMP is not supported by the bundled decoder. Convert it to PNG first.',
  '.ico': 'ICO is not supported by the bundled decoder.',
};

/** Files that mark a folder as a squoosh-mcp output folder; such folders are never re-scanned. */
export const OUTPUT_MARKERS = ['squoosh-manifest.json', '.squoosh-journal.jsonl'];
const TEMP_FILE = /\.tmp-[0-9a-f]+$/;
const GLOB_CHARS = /[*?[\]{}]/;

export interface DiscoveredFile {
  /** Real absolute path. */
  abs: string;
  /** The input root this file belongs to (outputs mirror paths relative to it). */
  root: string;
  /** Path relative to `root`, POSIX style. */
  rel: string;
}

export interface Discovery {
  files: DiscoveredFile[];
  skipped: { path: string; reason: string }[];
  truncated: boolean;
}

async function isOutputFolder(dir: string): Promise<boolean> {
  for (const marker of OUTPUT_MARKERS) {
    if (await fs.access(path.join(dir, marker)).then(() => true, () => false)) return true;
  }
  return false;
}

function skipName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Splits a glob into its fixed base folder and the pattern below it. Backslashes count as separators. */
function splitGlob(pattern: string): { base: string; rest: string } {
  const parts = pattern.replaceAll('\\', '/').split('/');
  const index = parts.findIndex((part) => GLOB_CHARS.test(part));
  return { base: parts.slice(0, index).join('/') || '.', rest: parts.slice(index).join('/') };
}

/**
 * Expands files, folders and globs into supported image files inside the sandbox.
 * Each entry's root is the folder given, the file's own folder, or the glob's fixed base.
 */
export async function discover(sandbox: Sandbox, entries: readonly string[], recursive = true): Promise<Discovery> {
  const seen = new Set<string>();
  const result: Discovery = { files: [], skipped: [], truncated: false };

  const add = (abs: string, root: string): boolean => {
    if (seen.has(abs)) return true;
    if (result.files.length >= config.maxFiles) {
      result.truncated = true;
      return false;
    }
    const ext = path.extname(abs).toLowerCase();
    if (TEMP_FILE.test(abs)) return true;
    if (REFUSED_EXTENSIONS[ext]) {
      result.skipped.push({ path: abs, reason: REFUSED_EXTENSIONS[ext] });
      return true;
    }
    if (!SUPPORTED_EXTENSIONS.has(ext)) return true;
    seen.add(abs);
    result.files.push({ abs, root, rel: toPosix(path.relative(root, abs)) });
    return true;
  };

  const walk = async (dir: string, root: string, depth: number): Promise<boolean> => {
    if (depth > config.maxGlobDepth) return true;
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (skipName(dirent.name)) continue;
      let full = path.join(dir, dirent.name);
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        const real = await fs.realpath(full).catch(() => undefined);
        if (!real || !sandbox.contains(real)) continue;
        full = real;
        isDir = (await fs.stat(real)).isDirectory();
      }
      if (isDir) {
        if (!recursive || (await isOutputFolder(full))) continue;
        if (!(await walk(full, root, depth + 1))) return false;
      } else if (!add(full, root)) {
        return false;
      }
    }
    return true;
  };

  const outputFolderCache = new Map<string, boolean>();
  /** True when any folder between `root` (exclusive) and the file is an output folder or hidden. */
  const underSkippedFolder = async (abs: string, root: string): Promise<boolean> => {
    for (let dir = path.dirname(abs); dir !== root && dir.startsWith(root); dir = path.dirname(dir)) {
      if (skipName(path.basename(dir))) return true;
      let flagged = outputFolderCache.get(dir);
      if (flagged === undefined) outputFolderCache.set(dir, (flagged = await isOutputFolder(dir)));
      if (flagged) return true;
    }
    return false;
  };

  for (const entry of entries) {
    if (result.truncated) break;
    if (GLOB_CHARS.test(entry)) {
      const { base, rest } = splitGlob(entry);
      const root = await sandbox.existing(base);
      for await (const match of fs.glob(rest, { cwd: root })) {
        const abs = await fs.realpath(path.join(root, match)).catch(() => undefined);
        if (!abs || !sandbox.contains(abs) || (await underSkippedFolder(abs, root))) continue;
        if ((await fs.stat(abs)).isFile() && !add(abs, root)) break;
      }
      continue;
    }
    const real = await sandbox.existing(entry);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
      if (await isOutputFolder(real)) {
        throw new UserError(`${entry} is a squoosh-mcp output folder. Point at the source images instead.`);
      }
      await walk(real, real, 0);
    } else {
      add(real, path.dirname(real));
    }
  }
  result.files.sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
  return result;
}
