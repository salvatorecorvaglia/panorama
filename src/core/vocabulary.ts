/**
 * The words and rankings both UI surfaces agree on.
 *
 * The tree view and the webview table present the same data, and until this
 * file existed they each had their own copy of "what is a scope called", "is
 * this outdated" and "how urgent is this" — which is why they could disagree
 * about ordering and vocabulary. Everything here has exactly one definition.
 *
 * Like `types.ts`, this file must not import `vscode`: the webview bundle pulls
 * it in.
 */

import type { Dependency, DepScope } from './types.js';

/** Declaration order everywhere a scope list is shown, most-used first. */
export const ALL_SCOPES: DepScope[] = [
  'prod',
  'dev',
  'build',
  'peer',
  'optional',
];

/**
 * `short` is for dense surfaces (table badges, filter chips); `long` is for the
 * tree, where a row has the width to spell it out.
 */
export const SCOPE_LABELS: Record<DepScope, { short: string; long: string }> = {
  prod: { short: 'prod', long: 'Production' },
  dev: { short: 'dev', long: 'Development' },
  build: { short: 'build', long: 'Build' },
  peer: { short: 'peer', long: 'Peer' },
  optional: { short: 'optional', long: 'Optional' },
};

/** The version we treat as "what you have right now". */
export function currentVersion(dep: Dependency): string {
  return dep.installed ?? dep.declared;
}

/**
 * The single definition of "outdated".
 *
 * `unknown` is deliberately excluded: a failed lookup is not evidence that an
 * update exists, and counting it as one produces badges that never clear.
 */
export function hasUpdate(dep: Dependency): boolean {
  return (
    dep.updateKind === 'patch' ||
    dep.updateKind === 'minor' ||
    dep.updateKind === 'major'
  );
}

/**
 * Problem severity, lowest number first. Used for the table's Status sort and
 * for the tree's ordering, so a package sits in the same relative place in both.
 */
export function statusRank(dep: Dependency): number {
  if (dep.vulnerabilities.length > 0) return 0;
  if (dep.meta?.deprecated) return 1;
  if (dep.updateKind === 'major') return 2;
  if (dep.updateKind === 'minor') return 3;
  if (dep.updateKind === 'patch') return 4;
  return 5;
}

/** Problems first, then outdated, then alphabetical. */
export function sortByStatus(dependencies: Dependency[]): Dependency[] {
  return [...dependencies].sort(
    (a, b) => statusRank(a) - statusRank(b) || a.name.localeCompare(b.name),
  );
}
