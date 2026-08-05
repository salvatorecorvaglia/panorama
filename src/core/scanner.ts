/**
 * Discovers manifests, parses them, and enriches every dependency with
 * resolved versions, registry state, metadata and advisories.
 *
 * This is the orchestrator: providers know their own ecosystem, the scanner
 * knows the pipeline.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  Dependency,
  Ecosystem,
  ParsedManifest,
  ProjectGroup,
  ScanSummary,
} from './types.js';
import { assignWorkspaces, readSidecarMembers } from './workspaces.js';
import type { MuteList } from './muteList.js';
import { classifyUpdate, constraintToApproxVersion, maxSatisfying, maxVersion } from './versions/index.js';
import { providerFor, providerForPath, manifestGlob, PROVIDERS } from '../providers/registry.js';
import type { ProviderContext } from '../providers/provider.js';
import { auditDependencies } from './audit.js';

export interface ScanResult {
  groups: ProjectGroup[];
  summary: ScanSummary;
}

export class Scanner {
  /** Guards against overlapping scans when several files change at once. */
  private inFlight: AbortController | undefined;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly muteList?: MuteList,
  ) {}

  /** Re-stamps `muted` and recomputes the summary without a full rescan. */
  resummarize(groups: ProjectGroup[], stale: boolean): ScanResult {
    this.applyMutes(groups);
    return { groups, summary: summarize(groups, stale) };
  }

  private applyMutes(groups: ProjectGroup[]): void {
    if (!this.muteList) return;
    for (const group of groups) {
      this.muteList.applyTo(group.dependencies);
    }
  }

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
    this.applyMutes(groups);

    const partial: ScanResult = { groups, summary: summarize(groups, false) };
    onPartial?.(partial);

    if (!options.checkUpdates || groups.length === 0) {
      return partial;
    }

    let stale = false;
    try {
      await this.enrichVersions(groups, signal);
      if (options.audit) {
        await auditDependencies(groups, this.ctx, signal);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // A network failure means we render whatever the cache had.
      stale = true;
    }

    // Re-applied after enrichment: a mute is scoped to the version it was taken
    // against, which is only known once `latest` has been resolved.
    this.applyMutes(groups);
    return { groups, summary: summarize(groups, stale) };
  }

  /** Finds and parses every manifest in the workspace. */
  private async collectGroups(): Promise<ProjectGroup[]> {
    const excludes = [
      ...vscode.workspace.getConfiguration('panorama').get<string[]>('excludeGlobs', []),
      ...(await this.gitignoreExcludes()),
    ];
    const excludePattern = excludes.length > 0 ? `{${excludes.join(',')}}` : undefined;

    const uris = await vscode.workspace.findFiles(manifestGlob(), excludePattern, 500);

    const groups: ProjectGroup[] = [];
    // Collected alongside the groups so workspace membership can be resolved
    // once every manifest is known.
    const parsed: Array<{ manifest: ParsedManifest; members: string[] }> = [];

    for (const uri of uris) {
      const provider = providerForPath(uri.fsPath);
      if (!provider) continue;

      const text = await this.ctx.readFile(uri.fsPath);
      if (text === null) continue;

      let manifest;
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
          const resolved = await provider.readLockfile(path.dirname(uri.fsPath), this.ctx);
          if (resolved.size > 0) {
            for (const dep of manifest.dependencies) {
              dep.installed ??= resolved.get(dep.name) ?? resolved.get(dep.name.toLowerCase());
            }
          }
        } catch {
          // Lockfile parsing is an optimisation, never a hard requirement.
        }
      }

      // Without a lockfile, approximate from the constraint so the table still
      // shows a number rather than a blank cell.
      for (const dep of manifest.dependencies) {
        dep.installed ??= constraintToApproxVersion(dep.declared);
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
      const text = await this.ctx.readFile(path.join(folder.uri.fsPath, '.gitignore'));
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
    const labelByPath = new Map(groups.map((group) => [group.manifestPath, group.label]));

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
          labelByPath.get(info.rootPath) ?? path.basename(path.dirname(info.rootPath));
      }
    }
  }

  /** One batched registry round-trip per ecosystem, then merge the results. */
  private async enrichVersions(groups: ProjectGroup[], signal: AbortSignal): Promise<void> {
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

    await Promise.all(
      [...byEcosystem.entries()].map(async ([ecosystem, names]) => {
        const provider = providerFor(ecosystem);
        const versions = await provider.fetchVersions([...names], this.ctx, signal);

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
            dep.wanted = maxSatisfying(ecosystem, info.versions, dep.declared) ?? dep.installed;

            if (info.deprecated) {
              dep.meta = { ...(dep.meta ?? { name: dep.name }), deprecated: info.deprecated };
            }

            // Compare against what is actually resolved, falling back to the
            // constraint's lower bound when nothing pins an exact version.
            const current = dep.installed ?? constraintToApproxVersion(dep.declared);
            dep.updateKind = classifyUpdate(ecosystem, current, dep.latest);
          }
        }
      }),
    );
  }

  /** Fetches rich metadata for a single package, on demand from the drawer. */
  async fetchDetails(dep: Dependency, signal?: AbortSignal) {
    const provider = providerFor(dep.ecosystem);
    return provider.fetchMetadata(dep.name, this.ctx, signal);
  }

  /** Registry search across one ecosystem or all of them. */
  async search(
    query: string,
    ecosystem: Ecosystem | 'all',
    signal: AbortSignal,
  ) {
    const targets =
      ecosystem === 'all' ? PROVIDERS : [providerFor(ecosystem)];

    const settled = await Promise.allSettled(
      targets.map((provider) => provider.search(query, this.ctx, signal)),
    );

    return settled
      .filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof PROVIDERS[0]['search']>>> =>
        entry.status === 'fulfilled',
      )
      .flatMap((entry) => entry.value);
  }
}

function summarize(groups: ProjectGroup[], stale: boolean): ScanSummary {
  let total = 0;
  let outdated = 0;
  let vulnerable = 0;
  let deprecated = 0;
  let muted = 0;

  for (const group of groups) {
    for (const dep of group.dependencies) {
      total++;
      const isOutdated =
        dep.updateKind === 'patch' || dep.updateKind === 'minor' || dep.updateKind === 'major';
      if (isOutdated) {
        // Muted updates are counted separately so the badge keeps meaning
        // "things I still need to look at".
        if (dep.muted) muted++;
        else outdated++;
      }
      // A vulnerability is never silenced by a mute — that decision was about
      // an upgrade being inconvenient, not about the risk going away.
      if (dep.vulnerabilities.length > 0) vulnerable++;
      if (dep.meta?.deprecated) deprecated++;
    }
  }

  return { totalDependencies: total, outdated, vulnerable, deprecated, muted, stale };
}

/**
 * A label that is short but unambiguous: the workspace-relative directory, or
 * the manifest's own name when it sits at the root.
 */
function relativeLabel(manifestPath: string, manifestName: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(manifestPath));
  if (!folder) return manifestName;

  const relative = path.relative(folder.uri.fsPath, path.dirname(manifestPath));
  const base = path.basename(manifestPath);

  // Several manifests can share a directory (pyproject.toml + requirements.txt),
  // so name the file when it is not the directory's obvious primary manifest.
  const suffix = base === 'package.json' || base === 'pyproject.toml' ? '' : ` · ${base}`;

  if (relative === '') return `${manifestName}${suffix}`;
  return `${relative}${suffix}`;
}
