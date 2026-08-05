/**
 * PHP: composer.json driven by composer.
 *
 * Packagist asks that clients identify themselves with a contact address in the
 * User-Agent; `core/http.ts` adds it from the `panorama.contactEmail` setting.
 */

import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
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
import { mapWithConcurrency } from '../node/index.js';
import { changelogUrlFor, normalizeRepositoryUrl } from '../shared/repository.js';

const PACKAGIST = 'https://packagist.org';
const REPO = 'https://repo.packagist.org';

/** Composer names are always `vendor/package`, lowercase. */
const NAME_PATTERN = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;

/**
 * Platform requirements are not packages — `php`, `ext-*` and `composer-*`
 * describe the runtime and have no Packagist entry.
 */
function isPlatformRequirement(name: string): boolean {
  return name === 'php' || /^(ext|lib|composer)-/.test(name) || name.startsWith('php-');
}

interface P2Response {
  packages: Record<
    string,
    Array<{
      name: string;
      version: string;
      description?: string;
      license?: string[];
      homepage?: string;
      source?: { url?: string };
      abandoned?: boolean | string;
    }>
  >;
}

export class ComposerProvider implements EcosystemProvider {
  readonly id = 'composer' as const;
  readonly manifestFiles = ['composer.json'];
  readonly lockFiles = ['composer.lock'];
  readonly osvEcosystem = 'Packagist';

  isValidPackageName(name: string): boolean {
    return NAME_PATTERN.test(name);
  }

  async parse(absolutePath: string, text: string, _ctx: ProviderContext): Promise<ParsedManifest> {
    const json = (parseJsonc(text) ?? {}) as {
      name?: string;
      require?: Record<string, string>;
      'require-dev'?: Record<string, string>;
    };

    const projectLabel = json.name ?? path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];

    const buckets: Array<[Record<string, string> | undefined, DepScope]> = [
      [json.require, 'prod'],
      [json['require-dev'], 'dev'],
    ];

    for (const [record, scope] of buckets) {
      for (const [name, declared] of Object.entries(record ?? {})) {
        if (isPlatformRequirement(name)) continue;
        dependencies.push({
          key: dependencyKey(absolutePath, scope, name),
          name,
          ecosystem: 'composer',
          scope,
          declared,
          updateKind: 'unknown',
          vulnerabilities: [],
          manifestPath: absolutePath,
          projectLabel,
        });
      }
    }

    return { ecosystem: 'composer', path: absolutePath, name: projectLabel, dependencies };
  }

  async readLockfile(manifestDir: string, ctx: ProviderContext): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const text = await ctx.readFile(path.join(manifestDir, 'composer.lock'));
    if (!text) return resolved;
    try {
      const lock = JSON.parse(text) as {
        packages?: Array<{ name: string; version: string }>;
        'packages-dev'?: Array<{ name: string; version: string }>;
      };
      for (const entry of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) {
        resolved.set(entry.name, entry.version.replace(/^v/, ''));
      }
    } catch {
      // Ignore malformed lockfiles.
    }
    return resolved;
  }

  async detectToolchain(manifestPath: string, _ctx: ProviderContext): Promise<Toolchain> {
    return { id: 'composer', ecosystem: 'composer', cwd: path.dirname(manifestPath) };
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const result = new Map<string, VersionInfo>();

    await mapWithConcurrency(names, 5, async (name) => {
      const key = cacheKey('packagist', 'versions', name);
      const cached = ctx.cache.get<VersionInfo>(key);
      if (cached) {
        result.set(name, cached);
        return;
      }

      try {
        const response = await ctx.http.getJson<P2Response>(`${REPO}/p2/${name}.json`, { signal });
        const releases = response.packages[name] ?? [];
        const abandoned = releases[0]?.abandoned;

        const info: VersionInfo = {
          // Strip the conventional `v` prefix so comparisons stay uniform.
          versions: releases.map((release) => release.version.replace(/^v/, '')),
          deprecated:
            abandoned === undefined || abandoned === false
              ? undefined
              : typeof abandoned === 'string'
                ? `Abandoned — use ${abandoned} instead`
                : 'This package is abandoned and no longer maintained',
        };
        result.set(name, info);
        await ctx.cache.set(key, info, TTL.version);
      } catch {
        const stale = ctx.cache.getStale<VersionInfo>(key);
        if (stale) result.set(name, stale);
      }
    });

    return result;
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    const key = cacheKey('packagist', 'meta', name);
    const cached = ctx.cache.get<PackageMeta>(key);
    if (cached) return cached;

    try {
      const response = await ctx.http.getJson<P2Response>(`${REPO}/p2/${name}.json`, { signal });
      const latest = response.packages[name]?.[0];
      if (!latest) return undefined;

      const repository = normalizeRepositoryUrl(latest.source?.url);
      const meta: PackageMeta = {
        name,
        description: latest.description,
        license: latest.license?.join(', '),
        homepage: latest.homepage,
        repository,
        changelogUrl: changelogUrlFor(repository),
        deprecated:
          latest.abandoned === undefined || latest.abandoned === false
            ? undefined
            : typeof latest.abandoned === 'string'
              ? `Abandoned — use ${latest.abandoned} instead`
              : 'This package is abandoned',
      };
      await ctx.cache.set(key, meta, TTL.metadata);
      return meta;
    } catch {
      return ctx.cache.getStale<PackageMeta>(key);
    }
  }

  async search(query: string, ctx: ProviderContext, signal?: AbortSignal): Promise<SearchResult[]> {
    interface SearchResponse {
      results: Array<{
        name: string;
        description?: string;
        downloads?: number;
        repository?: string;
        abandoned?: boolean | string;
      }>;
    }

    const response = await ctx.http.getJson<SearchResponse>(
      `${PACKAGIST}/search.json?q=${encodeURIComponent(query)}&per_page=25`,
      { signal },
    );

    return response.results.map((entry) => ({
      name: entry.name,
      version: '',
      description: entry.description,
      ecosystem: 'composer' as const,
      downloads: entry.downloads,
      repository: entry.repository,
      deprecated: entry.abandoned ? 'Abandoned' : undefined,
    }));
  }

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null {
    if (!this.isValidPackageName(name)) return null;
    const spec = version ? `${name}:${version}` : name;
    return {
      argv: ['composer', 'require', ...(scope === 'dev' ? ['--dev'] : []), spec],
      cwd: toolchain.cwd,
      description: `Require ${spec}`,
    };
  }

  updateCommand(toolchain: Toolchain, dep: Dependency, toVersion: string): Command | null {
    return this.installCommand(toolchain, dep.name, toVersion, dep.scope);
  }

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null {
    if (!this.isValidPackageName(dep.name)) return null;
    return {
      argv: ['composer', 'remove', ...(dep.scope === 'dev' ? ['--dev'] : []), dep.name],
      cwd: toolchain.cwd,
      description: `Remove ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    return {
      argv: ['composer', 'update'],
      cwd: toolchain.cwd,
      description: 'Update all packages within their declared constraints',
    };
  }
}
