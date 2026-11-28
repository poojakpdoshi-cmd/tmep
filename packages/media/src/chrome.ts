/**
 * Minimal Chromium driver over the DevTools Protocol (CDP), no dependencies.
 * Uses Node's built-in WebSocket (Node >= 22). Works with Google Chrome, Chromium and
 * Microsoft Edge (preinstalled on Windows). Set TMEP_CHROME to choose a binary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmepError } from '../../core/src/errors.ts';

export function chromeCandidates(): string[] {
  const chrome = process.env.FRAME_CHROME ?? process.env.TMEP_CHROME;
  const env = chrome ? [chrome] : [];
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return [
      ...env,
      ...roots.flatMap((r) => [path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Chromium', 'Application', 'chrome.exe'), path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
    ];
  }
  if (process.platform === 'darwin') {
    return [...env, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome'];
  return [...env, ...names.flatMap((n) => dirs.map((d) => path.join(d, n)))];
}

export function findChrome(): string | undefined {
  return chromeCandidates().find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export class ChromePage {
  private ws!: WebSocket;
  private proc!: ChildProcess;
  private userDir!: string;
  private seq = 0;
  private pending = new Map<number, Pending>();
  readonly events: { method: string; params: unknown }[] = [];

  static async launch(opts: { signal?: AbortSignal } = {}): Promise<ChromePage> {
    if (opts.signal?.aborted) throw new TmepError('E_CANCELLED', 'browser launch cancelled');
    const bin = findChrome();
    if (!bin) throw new TmepError('E_ENGINE_MISSING', 'no Chromium-based browser found for the web compositor', 'install Chrome/Edge or set TMEP_CHROME; or use captions engine "ass"');
    const p = new ChromePage();
    p.userDir = mkdtempSync(path.join(os.tmpdir(), 'tmep-chrome-'));
    p.proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${p.userDir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--no-pings', '--metrics-recording-only', '--disable-domain-reliability', '--disable-background-timer-throttling', '--allow-file-access-from-files', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    try {
      let port = 0;
      for (let i = 0; i < 200 && !port; i++) {
        if (opts.signal?.aborted) throw new TmepError('E_CANCELLED', 'browser launch cancelled');
        await new Promise((r) => setTimeout(r, 50));
        const f = path.join(p.userDir, 'DevToolsActivePort');
        try {
          port = Number(readFileSync(f, 'utf8').split('\n')[0]);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EBUSY') throw error;
        }
        if (p.proc.exitCode !== null) break;
      }
      if (!port) throw new TmepError('E_ENGINE_FAILED', `browser did not start (${bin})`);
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: opts.signal })).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === 'page');
      if (!page) throw new TmepError('E_ENGINE_FAILED', 'no page target');
      p.ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise<void>((res, rej) => {
        p.ws.onopen = () => res();
        p.ws.onerror = () => rej(new TmepError('E_ENGINE_FAILED', 'CDP websocket failed'));
      });
      const failPending = (reason: string) => {
        for (const [id, pd] of p.pending) {
          p.pending.delete(id);
          pd.reject(new TmepError('E_ENGINE_FAILED', reason));
        }
      };
      p.ws.onclose = () => failPending('CDP websocket closed unexpectedly');
      p.ws.onerror = () => failPending('CDP websocket error');
      p.ws.onmessage = (m) => {
        const d = JSON.parse(String(m.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: unknown };
        if (d.id !== undefined) {
          const pd = p.pending.get(d.id);
          if (!pd) return;
          p.pending.delete(d.id);
          if (d.error) pd.reject(new TmepError('E_ENGINE_FAILED', `CDP: ${d.error.message}`));
          else pd.resolve(d.result ?? {});
        } else if (d.method) {
          if (p.events.length >= 200) p.events.shift();
          p.events.push({ method: d.method, params: d.params });
        }
      };
      return p;
    } catch (e) {
      p.close();
      throw e;
    }
  }

  send(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    if (opts.signal?.aborted) return Promise.reject(new TmepError('E_CANCELLED', 'CDP command cancelled'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(new TmepError('E_ENGINE_FAILED', `CDP timeout after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(new TmepError('E_CANCELLED', `CDP command cancelled (${method})`));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => { cleanup(); resolve(v); },
        reject: (e) => { cleanup(); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (r.exceptionDetails) throw new TmepError('E_ENGINE_FAILED', `page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  async open(url: string, w: number, h: number): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await this.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 200; i++) {
      if (await this.eval<boolean>('!!((window.FRAME && window.FRAME.ready) || (window.TMEP && window.TMEP.ready))').catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    const errs = this.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => JSON.stringify(e.params).slice(0, 400));
    throw new TmepError('E_ENGINE_FAILED', 'compositor page did not become ready', errs.join(' | ') || undefined);
  }

  async screenshot(w: number, h: number, scale = 1, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
    const r = (await this.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 94 } : {}), optimizeForSpeed: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: w, height: h, scale } })) as { data: string };
    return Buffer.from(r.data, 'base64');
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      if (this.userDir) rmSync(this.userDir, { recursive: true, force: true });
    } catch {
      /* chrome may still hold files briefly */
    }
  }
}
