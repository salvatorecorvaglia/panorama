/**
 * Rust: Cargo.toml driven by cargo.
 *
 * crates.io is strict about client behaviour — a descriptive User-Agent is
 * mandatory and clients are capped at one request per second. Both rules are
 * enforced centrally in `core/http.ts`, so this provider just calls through.
 */

import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type {
  DepScope,
  Dependency,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
} from '../../core/types.js';
import { cacheKey, TTL } from '../../core/cache.js';
import {
  dependencyKey,
  type Command,
  type EcosystemProvider,
  type ProviderContext,
  type VersionInfo,
} from '../provider.js';
import { changelogUrlFor, normalizeRepositoryUrl } from '../shared/repository.js';

const REGISTRY = 'https://crates.io';
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

interface CrateResponse {
  crate: {
    name: string;
    description?: string;
    homepage?: string;
    repository?: string;
    documentation?: string;
    downloads?: number;
    max_stable_version?: string;
    newest_version?: string;
  };
  versions?: Array<{ num: string; yanked: boolean; crate_size?: number; license?: string }>;
}

export class CargoProvider implements EcosystemProvider {
  readonly id = 'cargo' as const;
  readonly manifestFiles = ['Cargo.toml'];
  readonly lockFiles = ['Cargo.lock'];
  readonly osvEcosystem = 'crates.io';
  readonly depsDevSystem = 'CARGO';

  isValidPackageName(name: string): boolean {
    return name.length <= 64 && NAME_PATTERN.test(name);
  }

  async parse(absolutePath: string, text: string, _ctx: ProviderContext): Promise<ParsedManifest> {
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch {
      return {
        ecosystem: 'cargo',
        path: absolutePath,
        name: path.basename(path.dirname(absolutePath)),
        dependencies: [],
      };
    }

    const pkg = doc.package as { name?: string } | undefined;
    const projectLabel = pkg?.name ?? path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];

    const buckets: Array<[string, DepScope]> = [
      ['dependencies', 'prod'],
      ['dev-dependencies', 'dev'],
      ['build-dependencies', 'build'],
    ];

    for (const [tableName, scope] of buckets) {
      const table = doc[tableName] as Record<string, unknown> | undefined;
      for (const [name, value] of Object.entries(table ?? {})) {
        const declared = cargoConstraint(value);
        // Path and git dependencies have no registry version to compare against.
        if (declared === null) continue;
        dependencies.push({
          key: dependencyKey(absolutePath, scope, name),
          name,
          ecosystem: 'cargo',
          scope,
          declared,
          updateKind: 'unknown',
          vulnerabilities: [],
          manifestPath: absolutePath,
          projectLabel,
        });
      }
    }

    // A virtual manifest declares [workspace] and no [package].
    const workspace = doc.workspace as { members?: string[] } | undefined;

    return {
      ecosystem: 'cargo',
      path: absolutePath,
      name: projectLabel,
      dependencies,
      workspaceMembers: workspace?.members,
      isWorkspaceRoot: workspace !== undefined && pkg === undefined,
    };
  }

  async readLockfile(manifestDir: string, ctx: ProviderContext): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const text = await ctx.readFile(path.join(manifestDir, 'Cargo.lock'));
    if (!text) return resolved;
    try {
      const doc = parseToml(text) as { package?: Array<{ name?: string; version?: string }> };
      for (const entry of doc.package ?? []) {
        if (entry.name && entry.version) resolved.set(entry.name, entry.version);
      }
    } catch {
      // An unparseable lockfile just means no resolved versions.
    }
    return resolved;
  }

  async detectToolchain(manifestPath: string, _ctx: ProviderContext): Promise<Toolchain> {
    return { id: 'cargo', ecosystem: 'cargo', cwd: path.dirname(manifestPath) };
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const result = new Map<string, VersionInfo>();

    // Deliberately sequential: crates.io allows one request per second, so
    // concurrency would only queue inside the rate limiter anyway.
    for (const name of names) {
      const key = cacheKey('crates', 'versions', name);
      const cached = ctx.cache.get<VersionInfo>(key);
      if (cached) {
        result.set(name, cached);
        continue;
      }

      try {
        const response = await ctx.http.getJson<CrateResponse>(
          `${REGISTRY}/api/v1/crates/${encodeURIComponent(name)}`,
          { signal },
        );
        const info: VersionInfo = {
          versions: (response.versions ?? []).filter((v) => !v.yanked).map((v) => v.num),
          latest: response.crate.max_stable_version ?? response.crate.newest_version,
        };
        result.set(name, info);
        await ctx.cache.set(key, info, TTL.version);
      } catch {
        const stale = ctx.cache.getStale<VersionInfo>(key);
        if (stale) result.set(name, stale);
      }
    }

    return result;
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    const key = cacheKey('crates', 'meta', name);
    const cached = ctx.cache.get<PackageMeta>(key);
    if (cached) return cached;

    try {
      const response = await ctx.http.getJson<CrateResponse>(
        `${REGISTRY}/api/v1/crates/${encodeURIComponent(name)}`,
        { signal },
      );
      const newest = response.versions?.[0];
      const repository = normalizeRepositoryUrl(response.crate.repository);

      const meta: PackageMeta = {
        name: response.crate.name,
        description: response.crate.description,
        license: newest?.license,
        homepage: response.crate.homepage ?? response.crate.documentation,
        repository,
        changelogUrl: changelogUrlFor(repository),
        sizeBytes: newest?.crate_size,
        downloads: response.crate.downloads,
      };
      await ctx.cache.set(key, meta, TTL.metadata);
      return meta;
    } catch {
      return ctx.cache.getStale<PackageMeta>(key);
    }
  }

  async search(query: string, ctx: ProviderContext, signal?: AbortSignal): Promise<SearchResult[]> {
    interface SearchResponse {
      crates: Array<{
        name: string;
        max_stable_version?: string;
        newest_version?: string;
        description?: string;
        downloads?: number;
        repository?: string;
      }>;
    }

    const response = await ctx.http.getJson<SearchResponse>(
      `${REGISTRY}/api/v1/crates?q=${encodeURIComponent(query)}&per_page=25`,
      { signal },
    );

    return response.crates.map((crate) => ({
      name: crate.name,
      version: crate.max_stable_version ?? crate.newest_version ?? '',
      description: crate.description,
      ecosystem: 'cargo' as const,
      downloads: crate.downloads,
      repository: crate.repository,
    }));
  }

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null {
    if (!this.isValidPackageName(name)) return null;
    const spec = version ? `${name}@${version}` : name;
    const flags = scope === 'dev' ? ['--dev'] : scope === 'build' ? ['--build'] : [];
    return {
      argv: ['cargo', 'add', spec, ...flags],
      cwd: toolchain.cwd,
      description: `Add ${spec}`,
    };
  }

  updateCommand(toolchain: Toolchain, dep: Dependency, toVersion: string): Command | null {
    return this.installCommand(toolchain, dep.name, toVersion, dep.scope);
  }

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null {
    if (!this.isValidPackageName(dep.name)) return null;
    return {
      argv: ['cargo', 'remove', dep.name],
      cwd: toolchain.cwd,
      description: `Remove ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    return {
      argv: ['cargo', 'update'],
      cwd: toolchain.cwd,
      description: 'Update all dependencies within their declared ranges',
    };
  }
}

/**
 * Cargo dependencies are either a version string or a table. Returns null for
 * path/git dependencies, which have no registry version to track.
 */
function cargoConstraint(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const table = value as Record<string, unknown>;
    if (table.path !== undefined || table.git !== undefined) return null;
    if (typeof table.version === 'string') return table.version;
    // A workspace-inherited dependency: the root manifest holds the constraint.
    if (table.workspace === true) return 'workspace';
  }
  return null;
}
