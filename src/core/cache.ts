/**
 * A TTL cache, optionally persisted in `ExtensionContext.globalState`.
 *
 * Version lookups are cheap to repeat but rude to repeat often, and persisting
 * across reloads is what lets Panorama render instantly on the second open —
 * and render *something* when the machine is offline.
 *
 * Two bounds keep that from turning into a leak. The in-memory mirror is an LRU
 * so a large monorepo cannot grow it without limit, and `prune()` drops lapsed
 * entries out of the Memento on activation — without it, every package ever
 * seen in any workspace accumulates as its own key in a blob VS Code loads
 * synchronously at startup.
 */

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  /** Present on the real VS Code Memento; used by `prune`. */
  keys?(): readonly string[];
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const STORAGE_PREFIX = 'panorama.cache.';

/**
 * How many entries the in-memory mirror holds. Comfortably above a large
 * monorepo's package count, so the LRU only engages on genuinely unbounded use.
 */
const DEFAULT_MAX_ENTRIES = 5000;

export const TTL = {
  /** Latest-version lookups: fresh enough to be useful, cheap enough to redo. */
  version: 60 * 60 * 1000,
  /** Descriptions, sizes — these barely move. */
  metadata: 24 * 60 * 60 * 1000,
  /** Advisories: worth re-checking a few times a day. */
  audit: 6 * 60 * 60 * 1000,
  /** The PyPI name index is enormous; refetch at most daily. */
  nameIndex: 24 * 60 * 60 * 1000,
} as const;

export interface SetOptions {
  /**
   * Whether the entry survives a reload. Defaults to true.
   *
   * Set false for values that are large enough to make `globalState` expensive
   * to load — the PyPI project index is tens of megabytes, and globalState is a
   * JSON blob VS Code reads and rewrites synchronously.
   */
  persist?: boolean;
}

export class TtlCache {
  /**
   * Mirrors persisted state so hot paths never touch the Memento.
   *
   * A `Map` preserves insertion order, which is all an LRU needs: re-inserting
   * on read moves an entry to the end, so the oldest is always first.
   */
  private readonly memory = new Map<string, Entry<unknown>>();

  constructor(
    private readonly storage: Memento,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.read<T>(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      // A lapsed entry sitting in the mirror does nobody any good — drop it
      // here rather than waiting on the LRU to eventually push it out by
      // count. That bound does nothing for a single oversized entry (the
      // PyPI name index is the case that motivated this): it is one of up to
      // `maxEntries`, so it would otherwise sit in memory for the life of the
      // window regardless of size. Storage is untouched: `prune()` already
      // owns that, and `getStale()` still needs to find it there.
      this.memory.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Returns a value even if its TTL has lapsed. Used for offline fallback, where
   * stale data beats an error screen — the UI badges it as stale.
   */
  getStale<T>(key: string): T | undefined {
    return this.read<T>(key)?.value;
  }

  async set<T>(
    key: string,
    value: T,
    ttlMs: number,
    options: SetOptions = {},
  ): Promise<void> {
    const entry: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
    this.remember(key, entry);
    if (options.persist !== false) {
      await this.storage.update(STORAGE_PREFIX + key, entry);
    }
  }

  /**
   * Drops every lapsed entry from the Memento.
   *
   * Called once on activation rather than on each write: the work is
   * proportional to what has accumulated, not to what is being stored, and
   * doing it on the write path would put a scan behind a full key enumeration.
   *
   * Returns the number of keys removed, which the caller may log.
   */
  async prune(now = Date.now()): Promise<number> {
    // A Memento without `keys()` (the test double, or an older host) simply
    // cannot be enumerated; there is nothing to do and nothing to report.
    const keys = this.storage.keys?.();
    if (!keys) return 0;

    let removed = 0;
    for (const storageKey of keys) {
      if (!storageKey.startsWith(STORAGE_PREFIX)) continue;
      const entry = this.storage.get<Entry<unknown>>(storageKey);
      // A malformed entry is as useless as an expired one.
      if (
        entry &&
        typeof entry.expiresAt === 'number' &&
        entry.expiresAt >= now
      )
        continue;

      try {
        await this.storage.update(storageKey, undefined);
      } catch {
        // Best-effort: a write that fails here just leaves one stale entry
        // behind, which is what happens if prune() never runs at all — not
        // worth losing the rest of the sweep, or turning into an unhandled
        // rejection for `void cache.prune()` at the call site.
        continue;
      }
      this.memory.delete(storageKey.slice(STORAGE_PREFIX.length));
      removed++;
    }
    return removed;
  }

  private read<T>(key: string): Entry<T> | undefined {
    const hot = this.memory.get(key) as Entry<T> | undefined;
    if (hot) {
      // Re-insert so this becomes the most recently used.
      this.memory.delete(key);
      this.memory.set(key, hot);
      return hot;
    }
    const cold = this.storage.get<Entry<T>>(STORAGE_PREFIX + key);
    if (cold) {
      this.remember(key, cold);
    }
    return cold;
  }

  private remember(key: string, entry: Entry<unknown>): void {
    // Delete first so a re-write moves the key to the end of the order.
    this.memory.delete(key);
    this.memory.set(key, entry);

    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memory.delete(oldest.value);
    }
  }
}

/** Builds a collision-free cache key from its parts. */
export function cacheKey(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}
