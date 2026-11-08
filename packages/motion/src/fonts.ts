/**
 * Cross-platform font resolution.
 *
 * libass on Windows FFmpeg builds frequently cannot use fontconfig defaults, which
 * silently falls back to an ugly font. TMEP therefore scans OS font folders itself
 * (parsing the OpenType `name`/`OS/2` tables, no dependencies), picks the first font
 * available from a preset's font stack, copies that file into the render job's
 * fonts/ folder and passes `fontsdir=fonts` to libass. Output is identical across
 * machines that have the same font installed.
 */
import { openSync, readSync, closeSync, readdirSync, statSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface FontFace {
  file: string;
  family: string;
  sub: string;
  full: string;
  weight: number;
  italic: boolean;
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  const n = readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

function decodeName(buf: Buffer, platform: number): string {
  if (platform === 3 || platform === 0) {
    const sw = Buffer.from(buf);
    sw.swap16();
    return sw.toString('utf16le');
  }
  return buf.toString('latin1');
}

export function readFontFace(file: string, faceOffset = 0): FontFace | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    let base = faceOffset;
    const head = readAt(fd, base, 12);
    if (head.length < 12) return undefined;
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      base = readAt(fd, 12, 4).readUInt32BE(0);
    }
    const hdr = readAt(fd, base, 12);
    const numTables = hdr.readUInt16BE(4);
    if (numTables > 200) return undefined;
    const dir = readAt(fd, base + 12, numTables * 16);
    let nameOff = 0;
    let nameLen = 0;
    let os2Off = 0;
    for (let i = 0; i < numTables; i++) {
      const tag = dir.toString('latin1', i * 16, i * 16 + 4);
      if (tag === 'name') {
        nameOff = dir.readUInt32BE(i * 16 + 8);
        nameLen = dir.readUInt32BE(i * 16 + 12);
      } else if (tag === 'OS/2') os2Off = dir.readUInt32BE(i * 16 + 8);
    }
    if (!nameOff || nameLen > 2_000_000) return undefined;
    const nt = readAt(fd, nameOff, nameLen);
    const count = nt.readUInt16BE(2);
    const strOff = nt.readUInt16BE(4);
    const names: Record<number, { s: string; score: number }> = {};
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      if (r + 12 > nt.length) break;
      const platform = nt.readUInt16BE(r);
      const lang = nt.readUInt16BE(r + 4);
      const id = nt.readUInt16BE(r + 6);
      const len = nt.readUInt16BE(r + 8);
      const off = nt.readUInt16BE(r + 10);
      if (![1, 2, 4, 16, 17].includes(id)) continue;
      const score = (platform === 3 && lang === 0x409 ? 3 : platform === 3 ? 2 : platform === 1 && lang === 0 ? 1 : 0) + (platform === 0 ? 2 : 0);
      if (names[id] && names[id]!.score >= score) continue;
      const raw = nt.subarray(strOff + off, strOff + off + len);
      names[id] = { s: decodeName(raw, platform).replace(/\0/g, '').trim(), score };
    }
    let weight = 400;
    let italic = false;
    if (os2Off) {
      const os2 = readAt(fd, os2Off, 64);
      if (os2.length >= 64) {
        weight = os2.readUInt16BE(4);
        italic = (os2.readUInt16BE(62) & 1) === 1;
      }
    }
    const family = names[16]?.s || names[1]?.s;
    if (!family) return undefined;
    const sub = names[17]?.s || names[2]?.s || 'Regular';
    const full = names[4]?.s || `${family} ${sub}`;
    return { file, family, sub, full, weight, italic: italic || /italic|oblique/i.test(sub) };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function fontDirs(): string[] {
  const home = os.homedir();
  const extra = (process.env.TMEP_FONTS_DIR ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const win = process.env.WINDIR ?? 'C:\\Windows';
    return [...extra, path.join(win, 'Fonts'), path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'darwin') return [...extra, '/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  return [...extra, '/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts')];
}

let index: FontFace[] | undefined;

export function fontIndex(): FontFace[] {
  if (index) return index;
  const out: FontFace[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (/\.(ttf|otf|ttc)$/i.test(e) && st.size < 40_000_000) {
        const face = readFontFace(p);
        if (face) out.push(face);
      }
    }
  };
  for (const d of fontDirs()) walk(d, 0);
  index = out;
  return out;
}

/** Font stacks per typographic role. First installed match wins. */
export const FONT_STACKS: Record<string, string[]> = {
  heavy: ['Montserrat ExtraBold', 'Montserrat Black', 'Poppins ExtraBold', 'Poppins Bold', 'Inter Black', 'Inter ExtraBold', 'Arial Black', 'Segoe UI Black', 'Helvetica Neue Bold', 'Arial Bold', 'Liberation Sans Bold', 'DejaVu Sans Bold', 'FreeSans Bold'],
  bold: ['Montserrat Bold', 'Poppins SemiBold', 'Inter Bold', 'Inter SemiBold', 'Segoe UI Bold', 'Arial Bold', 'Liberation Sans Bold', 'DejaVu Sans Bold', 'FreeSans Bold'],
  regular: ['Inter', 'Inter Regular', 'Montserrat Regular', 'Poppins Regular', 'Segoe UI', 'Arial', 'Liberation Sans', 'DejaVu Sans', 'FreeSans'],
  devanagari: ['Noto Sans Devanagari Bold', 'Mukta Bold', 'Hind Bold', 'Nirmala UI Bold', 'Mangal Bold', 'Mangal', 'Lohit Devanagari', 'Noto Sans Devanagari'],
};

export interface ResolvedFont {
  name: string;
  file?: string;
}

const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

export function resolveFont(roleOrName: string): ResolvedFont {
  const stack = FONT_STACKS[roleOrName] ?? [roleOrName, ...FONT_STACKS.heavy!];
  const faces = fontIndex().filter((f) => !f.italic);
  for (const want of stack) {
    const k = key(want);
    const hit = faces.find((f) => key(f.full) === k) ?? faces.find((f) => key(`${f.family} ${f.sub}`) === k) ?? (k === key(want) ? faces.find((f) => key(f.family) === k && /regular|book|normal/i.test(f.sub)) : undefined);
    if (hit) return { name: hit.full, file: hit.file };
  }
  return { name: stack[stack.length - 1] ?? 'Arial' };
}

/** Copy the resolved font files into `<dir>/fonts` for libass `fontsdir`. */
export function stageFonts(fonts: ResolvedFont[], dir: string): string {
  const out = path.join(dir, 'fonts');
  mkdirSync(out, { recursive: true });
  for (const f of fonts) {
    if (!f.file) continue;
    const dest = path.join(out, path.basename(f.file));
    if (!existsSync(dest)) copyFileSync(f.file, dest);
  }
  return out;
}

export function resetFontIndex(): void {
  index = undefined;
}
