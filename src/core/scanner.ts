/**
 * Discovers manifests, parses them, and enriches every dependency with
 * resolved versions, registry state, metadata and advisories.
 *
 * This is the orchestrator: providers know their own ecosystem, the scanner
 * knows the pipeline.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProviderContext, VersionInfo } from '../providers/provider.js';
import {
  manifestGlob,
  PROVIDERS,
  providerFor,
  providerForPath,
} from '../providers/registry.js';
import { auditDependencies } from './audit.js';
import type {
  Dependency,
  Ecosystem,
  ParsedManifest,
  ProjectGroup,
  ScanSummary,
  SearchResult,
} from './types.js';
import {
  classifyUpdate,
  constraintToApproxVersion,
  maxSatisfying,
  maxVersion,
} from './versions/index.js';
import { assignWorkspaces, readSidecarMembers } from './workspaces.js';

export interface ScanResult {
  groups: ProjectGroup[];
  summary: ScanSummary;
}

/**
 * Upper bound on manifests discovered per scan.
 *
 * A cap is necessary — `findFiles` over a pathological tree is unbounded work —
 * but hitting one silently is how a monorepo quietly loses projects, so the
 * scanner reports when it truncates and the panel says so.
 */
const MAX_MANIFESTS = 2000;

export class Scanner {
  /** Guards against overlapping scans when several files change at once. */
  private inFlight: AbortController | undefined;

  /**
   * True when the last scan hit `MAX_MANIFESTS`. Read by the host so it can
   * tell the user results are incomplete rather than letting them assume the
   * missing projects simply do not exist.
   */
  private truncated = false;

  get hitManifestLimit(): boolean {
    return this.truncated;
  }

  /** The cap, so the message the host shows and the limit cannot disagree. */
  static readonly manifestLimit = MAX_MANIFESTS;

  constructor(private readonly ctx: ProviderContext) {}

  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  /**
   * Runs the full pipeline. `onPartial` fires once with manifest data before
   * any network call, so the table paints immediately and fills in after.
   */
  async scan(
    options: { checkUpdates: boolean; audit: boolean },
    onPartial?: (result: ScanResult) => void,
  ): Promise<ScanResult> {
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const signal = controller.signal;

    const groups = await this.collectGroups();

    const partial: ScanResult = { groups, summary: summarize(groups, false) };
    onPartial?.(partial);

    if (!options.checkUpdates || groups.length === 0) {
      return partial;
    }

    let stale = false;
    try {
      // Only a total failure means "stale". One unreachable registry should
      // grey out its own ecosystem's rows, not relabel results that arrived
      // perfectly well from the other six.
      stale = await this.enrichVersions(groups, signal);

      // Deliberately outside the version-lookup outcome: advisories come from
      // OSV, not from the registries, so a registry being down is no reason to
      // skip the security check.
      if (options.audit) {
        await auditDependencies(groups, this.ctx, signal);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      stale = true;
    }

    return { groups, summary: summarize(groups, stale) };
  }

  /** Finds and parses every manifest in the workspace. */
  private async collectGroups(): Promise<ProjectGroup[]> {
    const excludes = [
      ...vscode.workspace
        .getConfiguration('panorama')
        .get<string[]>('excludeGlobs', []),
      ...(await this.gitignoreExcludes()),
    ];
    const excludePattern =
      excludes.length > 0 ? `{${excludes.join(',')}}` : undefined;

    const uris = await vscode.workspace.findFiles(
      manifestGlob(),
      excludePattern,
      MAX_MANIFESTS,
    );
    this.truncated = uris.length >= MAX_MANIFESTS;

    const groups: ProjectGroup[] = [];
    // Collected alongside the groups so workspace membership can be resolved
    // once every manifest is known.
    const parsed: Array<{ manifest: ParsedManifest; members: string[] }> = [];

    for (const uri of uris) {
      const provider = providerForPath(uri.fsPath);
      if (!provider) continue;

      const text = await this.ctx.readFile(uri.fsPath);
      if (text === null) continue;

      let manifest: ParsedManifest;
      try {
        manifest = await provider.parse(uri.fsPath, text, this.ctx);
      } catch {
        // One unparseable manifest must not sink the whole scan.
        continue;
      }

      // Members declared in the manifest, plus any from a sidecar file
      // (pnpm-workspace.yaml, go.work, settings.gradle) the manifest never
      // mentions. Recorded even for dependency-free roots, since a root's whole
      // job may be to declare members.
      const sidecar = await readSidecarMembers(manifest, this.ctx);
      const members = [...(manifest.workspaceMembers ?? []), ...sidecar];
      parsed.push({ manifest, members });

      if (manifest.dependencies.length === 0) continue;

      const toolchain = await provider.detectToolchain(uri.fsPath, this.ctx);

      // Fill in resolved versions from the lockfile where the provider has one.
      if (provider.readLockfile) {
        try {
          const resolved = await provider.readLockfile(
            path.dirname(uri.fsPath),
            this.ctx,
          );
          if (resolved.size > 0) {
            // Providers normalise their lockfile keys to whatever their
            // ecosystem considers canonical, so the manifest name has to go
            // through the same normalisation to find them. Without this, PEP
            // 503 alone loses every Python resolution: `typing_extensions` in
            // pyproject.toml never matches `typing-extensions` in uv.lock.
            const normalize =
              provider.normalizeName ?? ((name: string) => name);
            for (const dep of manifest.dependencies) {
              dep.installed ??=
                resolved.get(dep.name) ??
                resolved.get(dep.name.toLowerCase()) ??
                resolved.get(normalize(dep.name));
            }
          }
        } catch {
          // Lockfile parsing is an optimisation, never a hard requirement.
        }
      }

      // Without a lockfile, approximate from the constraint so the table still
      // shows a number rather than a blank cell — but record that it is a
      // guess, because the audit matches advisories against this value.
      for (const dep of manifest.dependencies) {
        if (dep.installed !== undefined) continue;
        const approximate = constraintToApproxVersion(dep.declared);
        if (approximate === undefined) continue;
        dep.installed = approximate;
        dep.installedIsApproximate = true;
      }

      groups.push({
        label: relativeLabel(uri.fsPath, manifest.name),
        manifestPath: uri.fsPath,
        ecosystem: manifest.ecosystem,
        toolchain: toolchain.id,
        dependencies: manifest.dependencies,
      });
    }

    this.applyWorkspaceInfo(groups, parsed);

    groups.sort((a, b) => a.label.localeCompare(b.label));
    return groups;
  }

  /**
   * Turns each workspace folder's `.gitignore` into exclude globs.
   *
   * `findFiles` does not consult `.gitignore` — only `files.exclude` and the
   * pattern we pass — so a vendored or generated tree would otherwise be
   * scanned and show up as a project the user does not own.
   *
   * Only directory-shaped, non-negated entries are translated; the full
   * gitignore grammar (negations, anchoring, character classes) is more than a
   * scan filter needs, and over-excluding would hide real manifests.
   */
  private async gitignoreExcludes(): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const globs = new Set<string>();

    for (const folder of folders) {
      const text = await this.ctx.readFile(
        path.join(folder.uri.fsPath, '.gitignore'),
      );
      if (!text) continue;

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        // A negation re-includes a path; honouring it would need full gitignore
        // semantics, so we skip the rule rather than get it subtly wrong.
        if (line.startsWith('!')) continue;
        // Anything with a glob or character class is left to git.
        if (/[*?[\]]/.test(line)) continue;

        const cleaned = line.replace(/^\/+/, '').replace(/\/+$/, '');
        if (cleaned === '' || cleaned.includes('..')) continue;

        globs.add(`**/${cleaned}/**`);
      }
    }

    return [...globs];
  }

  /**
   * Marks each group as a workspace root or a member of one, so the UI can say
   * where a package sits rather than showing a flat list of unrelated projects.
   */
  private applyWorkspaceInfo(
    groups: ProjectGroup[],
    parsed: Array<{ manifest: ParsedManifest; members: string[] }>,
  ): void {
    const assignments = assignWorkspaces(parsed);
    const labelByPath = new Map(
      groups.map((group) => [group.manifestPath, group.label]),
    );

    for (const group of groups) {
      const info = assignments.get(group.manifestPath);
      if (!info) continue;

      if (info.isRoot) {
        group.isWorkspaceRoot = true;
      }
      if (info.rootPath) {
        // A root with no dependencies of its own never became a group, so fall
        // back to its directory name rather than dropping the attribution.
        group.workspaceRootLabel =
          labelByPath.get(info.rootPath) ??
          path.basename(path.dirname(info.rootPath));
      }
    }
  }

  /**
   * One batched registry round-trip per ecosystem, then merge the results.
   *
   * Returns true only when *every* ecosystem failed, which is the one case that
   * genuinely means "you are looking at cached data". Ecosystems are isolated
   * from each other: a provider that throws marks its own dependencies
   * `lookupFailed` and leaves the rest untouched.
   */
  private async enrichVersions(
    groups: ProjectGroup[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const byEcosystem = new Map<Ecosystem, Set<string>>();
    for (const group of groups) {
      for (const dep of group.dependencies) {
        let names = byEcosystem.get(dep.ecosystem);
        if (!names) {
          names = new Set();
          byEcosystem.set(dep.ecosystem, names);
        }
        names.add(dep.name);
      }
    }

    if (byEcosystem.size === 0) return false;

    const outcomes = await Promise.all(
      [...byEcosystem.entries()].map(async ([ecosystem, names]) => {
        const provider = providerFor(ecosystem);

        let versions: Map<string, VersionInfo>;
        try {
          versions = await provider.fetchVersions([...names], this.ctx, signal);
        } catch (error) {
          // An abort is the caller's decision, not a registry failure, so it
          // propagates rather than being reported as an unreachable ecosystem.
          if (signal.aborted) throw error;
          this.markLookupFailed(groups, ecosystem);
          return false;
        }

        this.applyVersions(groups, ecosystem, versions);
        return true;
      }),
    );

    return outcomes.every((succeeded) => !succeeded);
  }

  private markLookupFailed(groups: ProjectGroup[], ecosystem: Ecosystem): void {
    for (const group of groups) {
      for (const dep of group.dependencies) {
        if (dep.ecosystem !== ecosystem) continue;
        dep.lookupFailed = true;
        dep.updateKind = 'unknown';
      }
    }
  }

  private applyVersions(
    groups: ProjectGroup[],
    ecosystem: Ecosystem,
    versions: Map<string, VersionInfo>,
  ): void {
    for (const group of groups) {
      for (const dep of group.dependencies) {
        if (dep.ecosystem !== ecosystem) continue;

        const info = versions.get(dep.name);
        if (!info || info.versions.length === 0) {
          dep.lookupFailed = true;
          dep.updateKind = 'unknown';
          continue;
        }

        dep.latest = info.latest ?? maxVersion(ecosystem, info.versions);
        dep.wanted =
          maxSatisfying(ecosystem, info.versions, dep.declared) ??
          dep.installed;

        if (info.deprecated) {
          dep.meta = {
            ...(dep.meta ?? { name: dep.name }),
            deprecated: info.deprecated,
          };
        }

        // Compare against what is actually resolved, falling back to the
        // constraint's lower bound when nothing pins an exact version.
        const current =
          dep.installed ?? constraintToApproxVersion(dep.declared);
        dep.updateKind = classifyUpdate(ecosystem, current, dep.latest);
      }
    }
  }

  /** Fetches rich metadata for a single package, on demand from the drawer. */
  async fetchDetails(dep: Dependency, signal?: AbortSignal) {
    const provider = providerFor(dep.ecosystem);
    return provider.fetchMetadata(dep.name, this.ctx, signal);
  }

  /**
   * Registry search across one ecosystem or all of them.
   *
   * Reports which registries failed alongside the results. One unreachable
   * registry out of seven is a footnote, but *every* registry failing used to
   * render as "No packages found" — which sends the user looking for a package
   * that is right where they thought it was.
   */
  async search(
    query: string,
    ecosystem: Ecosystem | 'all',
    signal: AbortSignal,
  ): Promise<{ results: SearchResult[]; failed: Ecosystem[] }> {
    const targets = ecosystem === 'all' ? PROVIDERS : [providerFor(ecosystem)];

    const settled = await Promise.allSettled(
      targets.map((provider) => provider.search(query, this.ctx, signal)),
    );

    const results: SearchResult[] = [];
    const failed: Ecosystem[] = [];

    settled.forEach((entry, index) => {
      if (entry.status === 'fulfilled') results.push(...entry.value);
      else failed.push(targets[index].id);
    });

    return { results, failed };
  }
}

function summarize(groups: ProjectGroup[], stale: boolean): ScanSummary {
  let total = 0;
  let outdated = 0;
  let vulnerable = 0;
  let deprecated = 0;

  for (const group of groups) {
    for (const dep of group.dependencies) {
      total++;
      const isOutdated =
        dep.updateKind === 'patch' ||
        dep.updateKind === 'minor' ||
        dep.updateKind === 'major';
      if (isOutdated) {
        outdated++;
      }
      if (dep.vulnerabilities.length > 0) vulnerable++;
      if (dep.meta?.deprecated) deprecated++;
    }
  }

  return {
    totalDependencies: total,
    outdated,
    vulnerable,
    deprecated,
    stale,
  };
}

/**
 * A label that is short but unambiguous: the workspace-relative directory, or
 * the manifest's own name when it sits at the root.
 */
function relativeLabel(manifestPath: string, manifestName: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(manifestPath),
  );
  if (!folder) return manifestName;

  const relative = path.relative(folder.uri.fsPath, path.dirname(manifestPath));
  const base = path.basename(manifestPath);

  // Several manifests can share a directory (pyproject.toml + requirements.txt),
  // so name the file when it is not the directory's obvious primary manifest.
  const suffix =
    base === 'package.json' || base === 'pyproject.toml' ? '' : ` · ${base}`;

  if (relative === '') return `${manifestName}${suffix}`;
  return `${relative}${suffix}`;
}
