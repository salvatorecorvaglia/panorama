/**
 * The TTL cache: expiry, offline fallback, and the two bounds that keep it from
 * growing without limit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, type Memento, TTL, TtlCache } from '../../src/core/cache.js';

/** A Memento that can be enumerated, like the real one. */
class MapMemento implements Memento {
  readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    // VS Code deletes the key when the value is undefined.
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

/** A Memento with no `keys()`, as an older host would present. */
class OpaqueMemento implements Memento {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

describe('TtlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a value within its TTL and nothing after', async () => {
    const cache = new TtlCache(new MapMemento());
    await cache.set('k', 'v', 1000);

    expect(cache.get('k')).toBe('v');
    vi.advanceTimersByTime(1001);
    expect(cache.get('k')).toBeUndefined();
  });

  it('still returns a lapsed value through getStale', async () => {
    // This is what renders a dependency table when the machine is offline.
    const cache = new TtlCache(new MapMemento());
    await cache.set('k', 'v', 1000);

    vi.advanceTimersByTime(5000);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.getStale('k')).toBe('v');
  });

  it('reads through to storage on a cold start', () => {
    const storage = new MapMemento();
    storage.store.set('panorama.cache.k', {
      value: 'from disk',
      expiresAt: Date.now() + 10_000,
    });

    // A fresh instance has an empty memory mirror, as after a reload.
    expect(new TtlCache(storage).get('k')).toBe('from disk');
  });

  it('persists by default and skips storage when asked not to', async () => {
    const storage = new MapMemento();
    const cache = new TtlCache(storage);

    await cache.set('persisted', 1, TTL.version);
    await cache.set('ephemeral', 2, TTL.nameIndex, { persist: false });

    expect(storage.store.has('panorama.cache.persisted')).toBe(true);
    expect(storage.store.has('panorama.cache.ephemeral')).toBe(false);
    // Still readable in this session — it just does not survive a reload.
    expect(cache.get('ephemeral')).toBe(2);
  });

  /*
   * The LRU bounds *memory*, not storage: a persisted entry evicted from the
   * mirror is still read back through the Memento, which is the whole point of
   * having a cold layer. So eviction is observed on non-persisted entries,
   * where the mirror is the only copy.
   */
  it('evicts the least recently used entry from memory once full', async () => {
    const cache = new TtlCache(new MapMemento(), 3);
    const ephemeral = { persist: false } as const;

    await cache.set('a', 1, 10_000, ephemeral);
    await cache.set('b', 2, 10_000, ephemeral);
    await cache.set('c', 3, 10_000, ephemeral);

    // Reading 'a' makes 'b' the least recently used.
    expect(cache.get('a')).toBe(1);
    await cache.set('d', 4, 10_000, ephemeral);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('keeps a persisted entry readable after it leaves the memory mirror', async () => {
    const cache = new TtlCache(new MapMemento(), 1);

    await cache.set('a', 'kept', 10_000);
    await cache.set('b', 'newer', 10_000);

    // 'a' is out of the mirror but still on disk, so it reads through.
    expect(cache.get('a')).toBe('kept');
  });

  describe('prune', () => {
    it('drops lapsed entries out of storage and keeps live ones', async () => {
      const storage = new MapMemento();
      const cache = new TtlCache(storage);

      await cache.set('fresh', 1, 60_000);
      await cache.set('stale', 2, 1000);
      vi.advanceTimersByTime(30_000);

      expect(await cache.prune()).toBe(1);
      expect(storage.store.has('panorama.cache.fresh')).toBe(true);
      expect(storage.store.has('panorama.cache.stale')).toBe(false);
    });

    it('leaves keys belonging to other extensions alone', async () => {
      const storage = new MapMemento();
      storage.store.set('someone.else', 'not ours');
      const cache = new TtlCache(storage);
      await cache.set('stale', 1, 1);
      vi.advanceTimersByTime(1000);

      await cache.prune();
      expect(storage.store.get('someone.else')).toBe('not ours');
    });

    it('drops malformed entries, which are as useless as expired ones', async () => {
      const storage = new MapMemento();
      storage.store.set('panorama.cache.broken', { value: 1 }); // no expiresAt
      storage.store.set('panorama.cache.alsoBroken', null);

      expect(await new TtlCache(storage).prune()).toBe(2);
      expect(storage.store.size).toBe(0);
    });

    it('does nothing when the Memento cannot be enumerated', async () => {
      // No `keys()` means no way to find what to prune; it must not throw.
      expect(await new TtlCache(new OpaqueMemento()).prune()).toBe(0);
    });
  });
});

describe('cacheKey', () => {
  it('encodes parts so they cannot collide across the separator', () => {
    // Without encoding, ('a:b', 'c') and ('a', 'b:c') would be one key.
    expect(cacheKey('a:b', 'c')).not.toBe(cacheKey('a', 'b:c'));
  });

  it('keeps distinct registries distinct', () => {
    expect(cacheKey('npm', 'versions', 'https://a', 'react')).not.toBe(
      cacheKey('npm', 'versions', 'https://b', 'react'),
    );
  });
});
