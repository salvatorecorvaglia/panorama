/**
 * A TTL cache persisted in `ExtensionContext.globalState`.
 *
 * Version lookups are cheap to repeat but rude to repeat often, and persisting
 * across reloads is what lets Panorama render instantly on the second open —
 * and render *something* when the machine is offline.
 */

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const STORAGE_PREFIX = 'panorama.cache.';

export const TTL = {
  /** Latest-version lookups: fresh enough to be useful, cheap enough to redo. */
  version: 60 * 60 * 1000,
  /** Descriptions, licenses, sizes — these barely move. */
  metadata: 24 * 60 * 60 * 1000,
  /** Advisories: worth re-checking a few times a day. */
  audit: 6 * 60 * 60 * 1000,
  /** The PyPI name index is enormous; refetch at most daily. */
  nameIndex: 24 * 60 * 60 * 1000,
} as const;

export class TtlCache {
  /** Mirrors persisted state so hot paths never touch the Memento. */
  private readonly memory = new Map<string, Entry<unknown>>();

  constructor(private readonly storage: Memento) {}

  get<T>(key: string): T | undefined {
    const entry = this.read<T>(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
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

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const entry: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
    this.memory.set(key, entry);
    await this.storage.update(STORAGE_PREFIX + key, entry);
  }

  private read<T>(key: string): Entry<T> | undefined {
    const hot = this.memory.get(key) as Entry<T> | undefined;
    if (hot) {
      return hot;
    }
    const cold = this.storage.get<Entry<T>>(STORAGE_PREFIX + key);
    if (cold) {
      this.memory.set(key, cold);
    }
    return cold;
  }
}

/** Builds a collision-free cache key from its parts. */
export function cacheKey(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}
