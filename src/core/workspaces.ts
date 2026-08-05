/**
 * Workspace and monorepo detection.
 *
 * Some ecosystems declare members inside the manifest (`workspaces` in
 * package.json, `[workspace]` in Cargo.toml, `<modules>` in pom.xml); others
 * use a sidecar file the manifest never mentions — `pnpm-workspace.yaml`,
 * `go.work`, `settings.gradle`. Providers handle the first kind while parsing;
 * this module handles the second, and then decides which discovered manifests
 * belong to which root.
 */

import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Ecosystem, ParsedManifest } from './types.js';
import type { ProviderContext } from '../providers/provider.js';

/**
 * Reads member globs from an ecosystem's sidecar workspace file, if it has one.
 * Returns an empty array when the file is absent or declares nothing.
 */
export async function readSidecarMembers(
  manifest: ParsedManifest,
  ctx: ProviderContext,
): Promise<string[]> {
  const dir = path.dirname(manifest.path);

  switch (manifest.ecosystem) {
    case 'node':
      return readPnpmWorkspace(dir, ctx);
    case 'golang':
      return readGoWork(dir, ctx);
    case 'gradle':
      return readGradleSettings(dir, ctx);
    default:
      return [];
  }
}

/** `packages:` is a YAML list of globs, so this is a real parse, not a regex. */
async function readPnpmWorkspace(dir: string, ctx: ProviderContext): Promise<string[]> {
  const text = await ctx.readFile(path.join(dir, 'pnpm-workspace.yaml'));
  if (!text) return [];

  try {
    const doc = parseYaml(text) as { packages?: unknown } | null;
    const packages = doc?.packages;
    if (!Array.isArray(packages)) return [];
    return packages.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    // A malformed workspace file should not break the scan.
    return [];
  }
}

/**
 * go.work lists module directories in a `use (...)` block, or as single
 * `use ./dir` lines.
 */
async function readGoWork(dir: string, ctx: ProviderContext): Promise<string[]> {
  const text = await ctx.readFile(path.join(dir, 'go.work'));
  if (!text) return [];

  const members: string[] = [];

  for (const block of text.matchAll(/use\s*\(([\s\S]*?)\)/g)) {
    for (const line of block[1].split(/\r?\n/)) {
      const entry = line.split('//')[0].trim();
      if (entry) members.push(entry);
    }
  }

  for (const single of text.matchAll(/^use\s+([^\s(]+)\s*$/gm)) {
    members.push(single[1].trim());
  }

  return members;
}

/**
 * settings.gradle(.kts) declares members as `include 'a', 'b'` using colon-
 * separated project paths (`:app:core`), which map onto directories.
 */
async function readGradleSettings(dir: string, ctx: ProviderContext): Promise<string[]> {
  for (const name of ['settings.gradle', 'settings.gradle.kts']) {
    const text = await ctx.readFile(path.join(dir, name));
    if (!text) continue;

    const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const members: string[] = [];

    for (const statement of source.matchAll(/\binclude\s*\(?\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)?/g)) {
      for (const quoted of statement[1].matchAll(/['"]([^'"]+)['"]/g)) {
        // `:app:core` is the Gradle path form of `app/core`.
        members.push(quoted[1].replace(/^:/, '').replace(/:/g, '/'));
      }
    }

    if (members.length > 0) return members;
  }

  return [];
}

/** A manifest plus everything we know about its place in a workspace. */
export interface WorkspaceInfo {
  /** Absolute path of the root manifest, when this one is a member. */
  rootPath?: string;
  /** True when this manifest declares members. */
  isRoot: boolean;
}

/**
 * Decides which of the discovered manifests are workspace roots and which are
 * members of one.
 *
 * Matching is done on directories rather than by expanding globs: a member glob
 * like `packages/*` only has to identify which already-discovered manifests sit
 * beneath it, which is a containment test plus a depth check.
 */
export function assignWorkspaces(
  manifests: Array<{ manifest: ParsedManifest; members: string[] }>,
): Map<string, WorkspaceInfo> {
  const result = new Map<string, WorkspaceInfo>();

  for (const { manifest } of manifests) {
    result.set(manifest.path, { isRoot: false });
  }

  for (const { manifest, members } of manifests) {
    if (members.length === 0) continue;

    const rootDir = path.dirname(manifest.path);
    result.set(manifest.path, { isRoot: true });

    for (const candidate of manifests) {
      if (candidate.manifest.path === manifest.path) continue;
      // Members only ever live below their root, and only in the same ecosystem.
      if (candidate.manifest.ecosystem !== manifest.ecosystem) continue;

      const candidateDir = path.dirname(candidate.manifest.path);
      const relative = path.relative(rootDir, candidateDir);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;

      if (members.some((member) => globMatchesPath(member, relative))) {
        const existing = result.get(candidate.manifest.path);
        // A nearer root wins, so nested workspaces attribute correctly.
        if (!existing?.rootPath || rootDir.length > path.dirname(existing.rootPath).length) {
          result.set(candidate.manifest.path, { isRoot: existing?.isRoot ?? false, rootPath: manifest.path });
        }
      }
    }
  }

  return result;
}

/**
 * Matches a workspace member glob against a root-relative directory path.
 *
 * Deliberately narrow: workspace globs in practice are `packages/*`,
 * `apps/**`, or a literal path. Full glob semantics would be more machinery
 * than the input justifies.
 */
export function globMatchesPath(pattern: string, relativePath: string): boolean {
  const normalisedPattern = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  const normalisedPath = relativePath.split(path.sep).join('/');

  if (normalisedPattern === normalisedPath) return true;
  // A negation is a exclusion rule, not a membership rule.
  if (normalisedPattern.startsWith('!')) return false;

  if (!normalisedPattern.includes('*')) {
    return normalisedPath === normalisedPattern;
  }

  const regex = new RegExp(
    '^' +
      normalisedPattern
        .split('/')
        .map((segment) => {
          if (segment === '**') return '.*';
          // A single star matches within one segment only.
          return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        })
        .join('/')
        // `a/**` should also match `a` itself.
        .replace(/\/\.\*$/, '(?:/.*)?') +
      '$',
  );

  return regex.test(normalisedPath);
}

/** Human label for an ecosystem's workspace concept, used in the UI. */
export function workspaceTermFor(ecosystem: Ecosystem): string {
  switch (ecosystem) {
    case 'maven':
    case 'gradle':
      return 'module';
    case 'golang':
      return 'go.work';
    default:
      return 'workspace';
  }
}
