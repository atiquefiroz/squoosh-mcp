import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A tool-facing error whose message tells the agent how to fix the call. */
export class UserError extends Error {
  override name = 'UserError';
}

const isRoot = (p: string) => path.parse(p).root === p;

/** True when `child` is `parent` or inside it. Both must be absolute and normalised. */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

/** POSIX-style relative path, for manifests and markup. */
export const toPosix = (p: string) => p.split(path.sep).join('/');

/**
 * The allow-list of folders the server may read and write, modelled on the official
 * filesystem server's path validation: real paths on both sides, containment with a
 * trailing separator, symlinks resolved, output paths checked through their parent.
 */
export class Sandbox {
  readonly roots: readonly string[];
  /** Each root as given and as its real path, lower-cased, for the check before touching the disk. */
  private readonly aliases: readonly string[];

  private constructor(roots: readonly string[], aliases: readonly string[]) {
    this.roots = roots;
    this.aliases = aliases;
  }

  static async create(dirs: readonly string[]): Promise<Sandbox> {
    const roots: string[] = [];
    const aliases = new Set<string>();
    for (const dir of dirs) {
      const abs = path.resolve(dir);
      const real = await fs.realpath(abs).catch(() => undefined);
      if (!real) throw new Error(`Allowed directory does not exist: ${dir}`);
      if (!(await fs.stat(real)).isDirectory()) throw new Error(`Allowed path is not a directory: ${dir}`);
      if (!roots.some((r) => isInside(r, real))) roots.push(real);
      aliases.add(abs.toLowerCase()).add(real.toLowerCase());
    }
    return new Sandbox(roots, [...aliases]);
  }

  /**
   * Allowed directories from CLI arguments, or Claude Code's CLAUDE_PROJECT_DIR when there are
   * none. The fallback is refused for the home folder or a filesystem root.
   */
  static async fromStartup(args: readonly string[], projectDir: string | undefined): Promise<Sandbox> {
    if (args.length > 0) return Sandbox.create(args);
    if (projectDir) {
      const real = await fs.realpath(projectDir).catch(() => undefined);
      if (real && real !== (await fs.realpath(os.homedir()).catch(() => os.homedir())) && !isRoot(real)) {
        return Sandbox.create([projectDir]);
      }
    }
    return new Sandbox([], []);
  }

  get describe(): string {
    return this.roots.length ? this.roots.join(', ') : '(none configured)';
  }

  private assertConfigured(): void {
    if (this.roots.length === 0) {
      throw new UserError(
        'No allowed directories are configured. Restart the server with one or more folder paths as arguments, ' +
          'for example: npx -y squoosh-mcp /absolute/path/to/images',
      );
    }
  }

  private outside(p: string): UserError {
    return new UserError(`Path is outside the allowed directories: ${p}. Allowed: ${this.describe}`);
  }

  /** Resolves a user path (absolute, or relative to the first allowed directory) to an absolute path. */
  absolute(p: string): string {
    this.assertConfigured();
    if (p.includes('\0')) throw new UserError('Path contains a null byte.');
    return path.normalize(path.isAbsolute(p) ? p : path.resolve(this.roots[0]!, p));
  }

  /**
   * Lexical check before touching the disk, so a refused path reveals nothing about what exists
   * outside. Case-insensitive because it only pre-filters: `contains` on the real path decides.
   */
  private reachable(abs: string): boolean {
    const lower = abs.toLowerCase();
    return this.aliases.some((alias) => isInside(alias, lower));
  }

  /** Resolves an existing file or directory and checks it is inside the sandbox. */
  async existing(p: string): Promise<string> {
    const abs = this.absolute(p);
    if (!this.reachable(abs)) throw this.outside(p);
    const real = await fs.realpath(abs).catch(() => {
      throw new UserError(`Path not found: ${p}`);
    });
    if (!this.contains(real)) throw this.outside(p);
    return real;
  }

  /** Checks a path that may not exist yet (an output) through its deepest existing ancestor. */
  async writable(p: string): Promise<string> {
    const abs = this.absolute(p);
    if (!this.reachable(abs)) throw this.outside(p);
    let probe = abs;
    let rest = '';
    for (;;) {
      const real = await fs.realpath(probe).catch(() => undefined);
      if (real) {
        const full = rest ? path.join(real, rest) : real;
        if (!this.contains(full)) throw this.outside(p);
        return full;
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw this.outside(p);
      rest = rest ? path.join(path.basename(probe), rest) : path.basename(probe);
      probe = parent;
    }
  }

  contains(real: string): boolean {
    return this.roots.some((root) => isInside(root, real));
  }
}
