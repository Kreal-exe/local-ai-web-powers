// Two-level cache (memory + disk) for search results and pages.
// The disk part survives LM Studio restarts, so follow-up questions still find the pages read earlier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const MAX_MEMORY_ENTRIES = 300;
const MAX_DISK_BYTES = 300 * 1024 * 1024;
const MAX_AGE_MS = 8 * 24 * 60 * 60_000; // PDFs and videos are kept 7 days

export const stats = { hits: 0, misses: 0 };

function defaultDir() {
  const base = process.platform === "win32"
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"));
  return path.join(base, "local-ai-web-powers");
}

type Entry = { at: number; ttl: number; value: Any };

export class Cache {
  private mem = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Any>>();
  private dir: string;
  private writes = 0;
  enabled = true;
  /** /fresh: ignore cached data but still store new results (decided per message by the plugin). */
  skipReadsFor: () => boolean = () => false;
  disk = true;

  constructor(dir = defaultDir()) {
    this.dir = dir;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { this.disk = false; }
  }

  private file(key: string) {
    return path.join(this.dir, crypto.createHash("sha1").update(key).digest("hex") + ".json");
  }

  get(key: string): Any {
    if (!this.enabled || this.skipReadsFor()) return null;
    let e = this.mem.get(key);
    if (!e && this.disk) {
      try { e = JSON.parse(fs.readFileSync(this.file(key), "utf8")); if (e) this.remember(key, e); } catch { /* miss */ }
    }
    if (!e) { stats.misses++; return null; }
    if (Date.now() - e.at > e.ttl) { this.delete(key); stats.misses++; return null; }
    stats.hits++;
    return e.value;
  }

  put(key: string, value: Any, ttlMs: number) {
    if (!this.enabled || ttlMs <= 0) return;
    const e: Entry = { at: Date.now(), ttl: ttlMs, value };
    this.remember(key, e);
    if (this.disk) {
      try { fs.writeFileSync(this.file(key), JSON.stringify(e)); } catch { /* disk full or read-only */ }
      if (++this.writes % 50 === 0) this.prune();
    }
  }

  delete(key: string) {
    this.mem.delete(key);
    if (this.disk) { try { fs.unlinkSync(this.file(key)); } catch { /* */ } }
  }

  /** Runs `fn` once per key at a time: parallel requests for the same page share one fetch. */
  async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear() {
    this.mem.clear();
    if (this.disk) {
      try { for (const f of fs.readdirSync(this.dir)) if (f.endsWith(".json")) fs.unlinkSync(path.join(this.dir, f)); } catch { /* */ }
    }
  }

  private remember(key: string, e: Entry) {
    this.mem.delete(key);
    this.mem.set(key, e);
    if (this.mem.size > MAX_MEMORY_ENTRIES) this.mem.delete(this.mem.keys().next().value as string);
  }

  /**
   * Keeps the folder under MAX_DISK_BYTES, oldest first, and drops files older than the longest lifetime.
   * Uses file times only (no parsing), so it never stalls the plugin; shorter-lived entries expire on read.
   */
  prune() {
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith(".json")).map(f => {
        const p = path.join(this.dir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, mtime: st.mtimeMs };
      }).sort((a, b) => a.mtime - b.mtime);
      let total = files.reduce((a, f) => a + f.size, 0);
      const now = Date.now();
      for (const f of files) {
        if (total > MAX_DISK_BYTES || now - f.mtime > MAX_AGE_MS) { try { fs.unlinkSync(f.p); total -= f.size; } catch { /* */ } }
      }
    } catch { /* */ }
  }
}

export const cache = new Cache();
