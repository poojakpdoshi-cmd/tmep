/**
 * Disk-based project state. Everything the agent would otherwise have to keep in its
 * context window (asset metadata, transcripts, analysis, timeline revisions, render
 * jobs) lives here and is referenced by short IDs.
 *
 * Layout:
 *   <root>/tmep.json                 manifest (head revision, redo stack, defaults)
 *   <root>/.tmep/assets.json         asset registry  (v1, a1, i1 ...)
 *   <root>/.tmep/revs/r0001.json     immutable timeline revisions + the ops that made them
 *   <root>/.tmep/cache/...           content-addressed cache (transcripts, analysis, units)
 *   <root>/.tmep/jobs/<id>.json      render job state (progress, result, errors)
 *   <root>/renders/                  user-facing outputs
 */
import { promises as fsp, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { TmepError } from './errors.ts';
import { readJsonOr, writeJson, readJson, exists } from './util.ts';
import type { Timeline } from './timeline.ts';

export type AssetKind = 'video' | 'audio' | 'image';

export interface Asset {
  id: string;
  kind: AssetKind;
  path: string;
  name: string;
  hash: string;
  dur: number;
  w?: number;
  h?: number;
  fps?: number;
  audio: boolean;
  vcodec?: string;
  acodec?: string;
  size: number;
  added: string;
  /** Cache key of the active transcript, once transcribed. */
  tr?: string;
  lang?: string;
}

interface AssetDb {
  next: Record<string, number>;
  assets: Record<string, Asset>;
}

export interface Manifest {
  v: 1;
  name: string;
  created: string;
  head: number;
  revs: number;
  redo: number[];
}

export interface Revision {
  rev: number;
  parent: number;
  at: string;
  ops: unknown[];
  note?: string;
  tl: Timeline;
}

const PREFIX: Record<AssetKind, string> = { video: 'v', audio: 'a', image: 'i' };

export class Project {
  readonly root: string;
  readonly dir: string;

  private constructor(root: string) {
    this.root = root;
    this.dir = path.join(root, '.tmep');
  }

  static async open(root: string, opts: { create?: boolean; name?: string } = {}): Promise<Project> {
    const abs = path.resolve(root);
    const p = new Project(abs);
    const has = await exists(p.manifestPath);
    if (!has) {
      if (!opts.create) throw new TmepError('E_STATE', `no TMEP project at ${abs}`, 'create one with `tmep init` or pass create:true');
      await fsp.mkdir(path.join(p.dir, 'revs'), { recursive: true });
      await fsp.mkdir(path.join(abs, 'renders'), { recursive: true });
      const m: Manifest = { v: 1, name: opts.name ?? path.basename(abs), created: new Date().toISOString(), head: 0, revs: 0, redo: [] };
      await writeJson(p.manifestPath, m);
      await writeJson(path.join(p.dir, 'assets.json'), { next: {}, assets: {} } satisfies AssetDb);
      await fsp.writeFile(path.join(p.dir, '.gitignore'), 'cache/\nwork/\njobs/\n');
    }
    return p;
  }

  get manifestPath(): string {
    return path.join(this.root, 'tmep.json');
  }
  cachePath(...parts: string[]): string {
    return path.join(this.dir, 'cache', ...parts);
  }
  workPath(...parts: string[]): string {
    return path.join(this.dir, 'work', ...parts);
  }
  jobPath(id: string): string {
    return path.join(this.dir, 'jobs', `${id}.json`);
  }
  rendersPath(...parts: string[]): string {
    return path.join(this.root, 'renders', ...parts);
  }

  async manifest(): Promise<Manifest> {
    return readJson<Manifest>(this.manifestPath);
  }

  /** Cross-process lock (CLI and MCP server may touch the same project). */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.dir, 'lock');
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 60000) unlinkSync(lock); // stale lock
        } catch {
          /* raced */
        }
        if (Date.now() > deadline) throw new TmepError('E_STATE', 'project is locked by another process');
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- assets ----------
  private async assetDb(): Promise<AssetDb> {
    return readJsonOr<AssetDb>(path.join(this.dir, 'assets.json'), { next: {}, assets: {} });
  }

  async assets(): Promise<Asset[]> {
    return Object.values((await this.assetDb()).assets);
  }

  async asset(id: string): Promise<Asset> {
    const db = await this.assetDb();
    const a = db.assets[id];
    if (!a) {
      const known = Object.keys(db.assets);
      throw new TmepError('E_NOT_FOUND', `asset ${id} not found`, known.length ? `known: ${known.slice(0, 10).join(',')}` : 'import media first');
    }
    return a;
  }

  /** Register media; identical content (same hash) returns the existing asset ID. */
  async addAsset(a: Omit<Asset, 'id' | 'added'>): Promise<{ asset: Asset; existed: boolean }> {
    return this.withLock(async () => {
      const db = await this.assetDb();
      const dup = Object.values(db.assets).find((x) => x.hash === a.hash && x.kind === a.kind);
      if (dup) {
        if (dup.path !== a.path) {
          dup.path = a.path; // file moved: keep ID, update location
          await writeJson(path.join(this.dir, 'assets.json'), db);
        }
        return { asset: dup, existed: true };
      }
      const pre = PREFIX[a.kind];
      const n = (db.next[pre] ?? 0) + 1;
      db.next[pre] = n;
      const asset: Asset = { ...a, id: `${pre}${n}`, added: new Date().toISOString() };
      db.assets[asset.id] = asset;
      await writeJson(path.join(this.dir, 'assets.json'), db);
      return { asset, existed: false };
    });
  }

  async updateAsset(id: string, patch: Partial<Asset>): Promise<Asset> {
    return this.withLock(async () => {
      const db = await this.assetDb();
      const a = db.assets[id];
      if (!a) throw new TmepError('E_NOT_FOUND', `asset ${id} not found`);
      Object.assign(a, patch);
      await writeJson(path.join(this.dir, 'assets.json'), db);
      return a;
    });
  }

  // ---------- revisions ----------
  private revPath(rev: number): string {
    return path.join(this.dir, 'revs', `r${String(rev).padStart(4, '0')}.json`);
  }

  async revision(rev?: number): Promise<Revision> {
    const m = await this.manifest();
    const r = rev ?? m.head;
    if (r === 0) throw new TmepError('E_STATE', 'project has no timeline yet', 'run video_plan (or `tmep plan`) or add clips with video_edit');
    if (r < 0 || r > m.revs) throw new TmepError('E_NOT_FOUND', `revision ${r} not found (head ${m.head})`);
    return readJson<Revision>(this.revPath(r));
  }

  async timeline(rev?: number): Promise<Timeline> {
    return (await this.revision(rev)).tl;
  }

  async hasTimeline(): Promise<boolean> {
    return (await this.manifest()).head > 0;
  }

  /** Append an immutable revision and move head. Clears the redo stack. */
  async commit(tl: Timeline, ops: unknown[], note?: string): Promise<number> {
    return this.withLock(async () => {
      const m = await this.manifest();
      const rev = m.revs + 1;
      const r: Revision = { rev, parent: m.head, at: new Date().toISOString(), ops, note, tl };
      await writeJson(this.revPath(rev), r, false);
      m.revs = rev;
      m.head = rev;
      m.redo = [];
      await writeJson(this.manifestPath, m);
      return rev;
    });
  }

  async undo(steps = 1): Promise<number> {
    return this.withLock(async () => {
      const m = await this.manifest();
      for (let i = 0; i < steps; i++) {
        if (m.head === 0) break;
        const r = await readJson<Revision>(this.revPath(m.head));
        m.redo.push(m.head);
        m.head = r.parent;
      }
      await writeJson(this.manifestPath, m);
      return m.head;
    });
  }

  async redo(steps = 1): Promise<number> {
    return this.withLock(async () => {
      const m = await this.manifest();
      for (let i = 0; i < steps && m.redo.length; i++) m.head = m.redo.pop()!;
      await writeJson(this.manifestPath, m);
      return m.head;
    });
  }

  async checkout(rev: number): Promise<number> {
    return this.withLock(async () => {
      const m = await this.manifest();
      if (rev < 0 || rev > m.revs) throw new TmepError('E_NOT_FOUND', `revision ${rev} not found`);
      m.head = rev;
      m.redo = [];
      await writeJson(this.manifestPath, m);
      return rev;
    });
  }

  async log(limit = 10): Promise<{ rev: number; parent: number; ops: number; note?: string }[]> {
    const m = await this.manifest();
    const out: { rev: number; parent: number; ops: number; note?: string }[] = [];
    let r = m.head;
    while (r > 0 && out.length < limit) {
      const rv = await readJson<Revision>(this.revPath(r));
      out.push({ rev: rv.rev, parent: rv.parent, ops: rv.ops.length, note: rv.note });
      r = rv.parent;
    }
    return out;
  }
}
