/**
 * The per-project mute list.
 *
 * Some updates are deliberately skipped — a major you are not ready for, a
 * package pinned for a reason. Without somewhere to record that, the outdated
 * badge stays permanently red and stops meaning anything. Muting removes a
 * package from the counts while leaving it visible and clearly marked.
 *
 * Stored in `workspaceState`, so a decision made in one project does not leak
 * into another — and keyed by manifest, so a decision made in one *package of a
 * monorepo* does not leak into its siblings either. Those are genuinely
 * separate decisions: pinning React in `packages/legacy` says nothing about
 * whether `packages/next` should upgrade.
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
  /** Absolute path of the manifest this mute belongs to. */
  manifestPath?: string;
  /**
   * The version the mute was taken against. When a newer version than this
   * appears the mute lapses, so muting "1.0 → 2.0" does not also silence 3.0.
   */
  mutedAtLatest?: string;
}

export class MuteList {
  private entries: Record<string, MuteEntry>;

  constructor(private readonly storage: Memento) {
    this.entries = migrate(
      storage.get<Record<string, MuteEntry>>(STORAGE_KEY) ?? {},
    );
  }

  private static key(dep: Dependency): string {
    return `${dep.manifestPath}::${dep.ecosystem}:${dep.name}`;
  }

  isMuted(dep: Dependency): boolean {
    const entry = this.entries[MuteList.key(dep)] ?? this.legacyEntry(dep);
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

  /**
   * A mute recorded before mutes were scoped to a manifest.
   *
   * Those entries were workspace-wide by construction, so they keep applying
   * everywhere until the user toggles them — at which point the new, narrower
   * key takes over. Rewriting them on read would silently widen or narrow a
   * decision the user made under different rules.
   */
  private legacyEntry(dep: Dependency): MuteEntry | undefined {
    const entry = this.entries[`${dep.ecosystem}:${dep.name}`];
    return entry && entry.manifestPath === undefined ? entry : undefined;
  }

  async mute(dep: Dependency): Promise<void> {
    this.entries[MuteList.key(dep)] = {
      ecosystem: dep.ecosystem,
      name: dep.name,
      manifestPath: dep.manifestPath,
      mutedAtLatest: dep.latest,
    };
    await this.persist();
  }

  async unmute(dep: Dependency): Promise<void> {
    delete this.entries[MuteList.key(dep)];
    // Unmuting also clears any pre-scoping entry, or the package would stay
    // muted and the button would appear not to work.
    delete this.entries[`${dep.ecosystem}:${dep.name}`];
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

/**
 * Keeps stored entries readable across the change in key shape.
 *
 * Nothing is rewritten — old entries are simply left under their old keys, and
 * `legacyEntry` still honours them. This exists so the shape is validated once
 * on load rather than trusted blindly.
 */
function migrate(stored: Record<string, MuteEntry>): Record<string, MuteEntry> {
  const entries: Record<string, MuteEntry> = {};
  for (const [key, entry] of Object.entries(stored)) {
    if (entry && typeof entry.name === 'string') entries[key] = entry;
  }
  return entries;
}
