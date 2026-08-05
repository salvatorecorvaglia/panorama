/**
 * The per-workspace mute list.
 *
 * Some updates are deliberately skipped — a major you are not ready for, a
 * package pinned for a reason. Without somewhere to record that, the outdated
 * badge stays permanently red and stops meaning anything. Muting removes a
 * package from the counts while leaving it visible and clearly marked.
 *
 * Stored in `workspaceState`, so a decision made in one project does not leak
 * into another.
 */

import type { Dependency, Ecosystem } from './types.js';

const STORAGE_KEY = 'panorama.mutedUpdates';

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** A muted entry, optionally scoped to the version that was muted. */
interface MuteEntry {
  ecosystem: Ecosystem;
  name: string;
  /**
   * The version the mute was taken against. When a newer version than this
   * appears the mute lapses, so muting "1.0 → 2.0" does not also silence 3.0.
   */
  mutedAtLatest?: string;
}

export class MuteList {
  private entries: Record<string, MuteEntry>;

  constructor(private readonly storage: Memento) {
    this.entries = storage.get<Record<string, MuteEntry>>(STORAGE_KEY) ?? {};
  }

  private static key(ecosystem: Ecosystem, name: string): string {
    return `${ecosystem}:${name}`;
  }

  isMuted(dep: Dependency): boolean {
    const entry = this.entries[MuteList.key(dep.ecosystem, dep.name)];
    if (!entry) return false;
    // A mute covers the version it was taken at and nothing beyond it.
    if (
      entry.mutedAtLatest &&
      dep.latest &&
      dep.latest !== entry.mutedAtLatest
    ) {
      return false;
    }
    return true;
  }

  async mute(dep: Dependency): Promise<void> {
    this.entries[MuteList.key(dep.ecosystem, dep.name)] = {
      ecosystem: dep.ecosystem,
      name: dep.name,
      mutedAtLatest: dep.latest,
    };
    await this.persist();
  }

  async unmute(dep: Dependency): Promise<void> {
    delete this.entries[MuteList.key(dep.ecosystem, dep.name)];
    await this.persist();
  }

  async toggle(dep: Dependency): Promise<boolean> {
    const nowMuted = !this.isMuted(dep);
    if (nowMuted) {
      await this.mute(dep);
    } else {
      await this.unmute(dep);
    }
    return nowMuted;
  }

  async clear(): Promise<void> {
    this.entries = {};
    await this.persist();
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }

  /** Stamps `muted` onto every dependency so the webview can render it. */
  applyTo(dependencies: Dependency[]): void {
    for (const dep of dependencies) {
      dep.muted = this.isMuted(dep);
    }
  }

  private async persist(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.entries);
  }
}
