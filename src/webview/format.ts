/** Small presentation helpers shared across the webview components. */

import type {
  Dependency,
  DepScope,
  Ecosystem,
  UpdateKind,
} from '../core/types.js';

export const SCOPE_LABELS: Record<DepScope, string> = {
  prod: 'prod',
  dev: 'dev',
  build: 'build',
  optional: 'optional',
  peer: 'peer',
};

export const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  node: 'npm',
  python: 'PyPI',
  cargo: 'crates.io',
  golang: 'Go',
  composer: 'Packagist',
  maven: 'Maven',
  gradle: 'Gradle',
};

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDownloads(downloads: number | undefined): string {
  if (downloads === undefined) return '';
  if (downloads >= 1_000_000) return `${(downloads / 1_000_000).toFixed(1)}M`;
  if (downloads >= 1_000) return `${Math.round(downloads / 1_000)}k`;
  return String(downloads);
}

export function updateClass(kind: UpdateKind): string {
  return `update--${kind === 'unknown' ? 'none' : kind}`;
}

/** The version we treat as "what you have right now". */
export function currentVersion(dep: Dependency): string {
  return dep.installed ?? dep.declared;
}

export function hasUpdate(dep: Dependency): boolean {
  return (
    dep.updateKind === 'patch' ||
    dep.updateKind === 'minor' ||
    dep.updateKind === 'major'
  );
}
