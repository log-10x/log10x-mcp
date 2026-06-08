/**
 * Local-file backed env-config store.
 *
 * Layout: `~/.log10x/envs/${env_id}.json`, mode 0600. The directory is created
 * lazily on first write (mkdir -p with 0700). The store assumes `$HOME` is
 * writeable and so reports `isAvailable: true` unconditionally — it sits at
 * the bottom of the resolver chain as the dev/local fallback under k8s, SSM,
 * GCP Secret Manager, and Azure App Configuration.
 *
 * Reads accept either an env_id (filename match) or a nickname (scan + match
 * on the parsed `nickname` field). Writes always key by env_id, so renaming a
 * nickname does not orphan the file. Documents are validated against
 * `environmentConfigSchema` on the way in AND out so a hand-edited file with
 * a busted shape fails loudly at read time rather than poisoning downstream
 * tools.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { environmentConfigSchema, type EnvironmentConfig } from './types.js';
import type { EnvConfigStore, StoreKind } from './store-interface.js';

const ENV_DIR = path.join(homedir(), '.log10x', 'envs');
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class LocalFileStore implements EnvConfigStore {
  readonly kind: StoreKind = 'local';

  private readonly dir: string;

  constructor(dir: string = ENV_DIR) {
    this.dir = dir;
  }

  /**
   * Always available — assumes `$HOME` is writeable. The actual write may
   * still fail on a read-only home directory, but that surfaces as a thrown
   * error from `write()` rather than a silent skip.
   */
  async isAvailable(): Promise<{ available: boolean; reason: string }> {
    return { available: true, reason: `local file store at ${this.dir}` };
  }

  /**
   * Resolve by env_id (filename match) first, then fall back to a directory
   * scan for nickname match. Returns `null` when nothing matches.
   */
  async read(envIdOrNickname: string): Promise<EnvironmentConfig | null> {
    // Fast path: env_id → filename.
    const byId = await this.readFile(this.fileFor(envIdOrNickname));
    if (byId) return byId;

    // Slow path: scan for nickname.
    const all = await this.list();
    return all.find(c => c.nickname === envIdOrNickname) ?? null;
  }

  /**
   * Write the document keyed by env_id. Creates the directory on first write
   * (mode 0700). File is written with mode 0600.
   */
  async write(config: EnvironmentConfig): Promise<void> {
    const parsed = environmentConfigSchema.parse(config);
    await fs.mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const target = this.fileFor(parsed.env_id);
    await fs.writeFile(target, JSON.stringify(parsed, null, 2), { mode: FILE_MODE });
  }

  /**
   * Returns every parseable document in the directory. Files that fail schema
   * validation are skipped silently — a single hand-edited bad file should not
   * blind the resolver to its neighbours. (Read-by-id still surfaces the
   * parse error for the specific file the caller asked for.)
   */
  async list(): Promise<EnvironmentConfig[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if (isNoEnt(err)) return [];
      throw err;
    }

    const out: EnvironmentConfig[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const full = path.join(this.dir, entry);
      try {
        const raw = await fs.readFile(full, 'utf8');
        const parsed = environmentConfigSchema.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // Skip unreadable / malformed files in a list scan.
      }
    }
    return out;
  }

  async delete(envId: string): Promise<void> {
    try {
      await fs.unlink(this.fileFor(envId));
    } catch (err) {
      if (isNoEnt(err)) return;
      throw err;
    }
  }

  private fileFor(envId: string): string {
    return path.join(this.dir, `${envId}.json`);
  }

  private async readFile(filePath: string): Promise<EnvironmentConfig | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (isNoEnt(err)) return null;
      throw err;
    }
    const parsed = environmentConfigSchema.parse(JSON.parse(raw));
    return parsed;
  }
}

function isNoEnt(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
