/**
 * Node ecosystem: package.json driven by npm, yarn, pnpm or bun.
 *
 * npm's registry is the richest of the seven — it reports deprecation, unpacked
 * size and repository links inline — so this provider needs no side lookups.
 */

import * as path from 'node:path';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { cacheKey, TTL } from '../../core/cache.js';
import type {
  Dependency,
  DepScope,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
  ToolchainId,
} from '../../core/types.js';
import {
  type Command,
  dependencyKey,
  type EcosystemProvider,
  type ProviderContext,
  type VersionInfo,
} from '../provider.js';
import { fetchVersionsWithCache } from '../shared/cachedFetch.js';
import {
  changelogUrlFor,
  normalizeRepositoryUrl,
} from '../shared/repository.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Scoped or plain, matching npm's own naming rules.
 *
 * Uppercase is accepted even though the registry has rejected it for new
 * packages since 2017: names published before then keep their capitals, and a
 * project depending on one could otherwise never be updated or removed from the
 * panel.
 */
const NAME_PATTERN =
  /^(?:@[A-Za-z0-9-~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$/;

interface PackageJson {
  name?: string;
  version?: string;
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The abbreviated packument — a fraction of the full document's size. */
interface Packument {
  name: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
  time?: Record<string, string>;
}

interface PackumentVersion {
  version: string;
  deprecated?: string;
  dist?: { unpackedSize?: number; tarball?: string; size?: number };
  description?: string;
  homepage?: string;
  repository?: string | { url?: string };
  author?: string | { name?: string };
}

export class NodeProvider implements EcosystemProvider {
  readonly id = 'node' as const;
  readonly manifestFiles = ['package.json'];
  readonly lockFiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ];
  readonly osvEcosystem = 'npm';
  readonly depsDevSystem = 'NPM';

  isValidPackageName(name: string): boolean {
    return name.length <= 214 && NAME_PATTERN.test(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    const errors: ParseError[] = [];
    const json = (parseJsonc(text, errors, { allowTrailingComma: true }) ??
      {}) as PackageJson;

    const projectLabel = json.name ?? path.basename(path.dirname(absolutePath));
    const dependencies: Dependency[] = [];

    const buckets: Array<[Record<string, string> | undefined, DepScope]> = [
      [json.dependencies, 'prod'],
      [json.devDependencies, 'dev'],
      [json.optionalDependencies, 'optional'],
      [json.peerDependencies, 'peer'],
    ];

    for (const [record, scope] of buckets) {
      for (const [name, declared] of Object.entries(record ?? {})) {
        dependencies.push({
          key: dependencyKey(absolutePath, scope, name),
          name,
          ecosystem: 'node',
          scope,
          declared,
          updateKind: 'unknown',
          vulnerabilities: [],
          manifestPath: absolutePath,
          projectLabel,
        });
      }
    }

    const workspaceGlobs = Array.isArray(json.workspaces)
      ? json.workspaces
      : (json.workspaces?.packages ?? []);

    return {
      ecosystem: 'node',
      path: absolutePath,
      name: projectLabel,
      dependencies,
      workspaceMembers: workspaceGlobs,
      isWorkspaceRoot: workspaceGlobs.length > 0 && dependencies.length === 0,
    };
  }

  async readLockfile(
    manifestDir: string,
    ctx: ProviderContext,
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();

    const npmLock = await ctx.readFile(
      path.join(manifestDir, 'package-lock.json'),
    );
    if (npmLock) {
      try {
        const parsed = JSON.parse(npmLock) as {
          packages?: Record<string, { version?: string }>;
          dependencies?: Record<string, { version?: string }>;
        };
        // Direct top-level install paths (e.g. "node_modules/semver") take priority
        for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
          if (!key.startsWith('node_modules/') || !entry.version) continue;
          const relative = key.slice('node_modules/'.length);
          if (!relative.includes('node_modules/')) {
            resolved.set(relative, entry.version);
          }
        }
        // Fallback for nested or legacy dependencies
        for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
          if (!key.startsWith('node_modules/') || !entry.version) continue;
          const name = key
            .slice('node_modules/'.length)
            .replace(/.*\/node_modules\//, '');
          if (!resolved.has(name)) resolved.set(name, entry.version);
        }
        for (const [name, entry] of Object.entries(parsed.dependencies ?? {})) {
          if (entry.version && !resolved.has(name))
            resolved.set(name, entry.version);
        }
      } catch {
        // A malformed lockfile is not worth failing the scan over.
      }
      return resolved;
    }

    const pnpmLock = await ctx.readFile(
      path.join(manifestDir, 'pnpm-lock.yaml'),
    );
    if (pnpmLock) {
      // Direct dependencies under `importers` or root `dependencies`/`devDependencies`
      const directPattern =
        /^\s{4,6}(@?[^:\s]+):\n\s{6,8}(?:specifier:[^\n]+\n\s{6,8})?version:\s*['"]?([0-9][^(\s'"]+)/gm;
      for (const match of pnpmLock.matchAll(directPattern)) {
        if (!resolved.has(match[1])) resolved.set(match[1], match[2]);
      }
      // Entries look like `/react@18.2.0:` or `react@18.2.0:` depending on version.
      const pattern = /^\s{2}\/?(@?[^@\s:]+(?:\/[^@\s:]+)?)@([^(:\s]+)/gm;
      for (const match of pnpmLock.matchAll(pattern)) {
        if (!resolved.has(match[1])) resolved.set(match[1], match[2]);
      }
      return resolved;
    }

    const yarnLock = await ctx.readFile(path.join(manifestDir, 'yarn.lock'));
    if (yarnLock) {
      // Yarn v1 blocks: `name@range:` then an indented `version "x.y.z"`.
      const blocks = yarnLock.split(/\n(?=\S)/);
      for (const block of blocks) {
        const header = /^"?(@?[^@\s"]+(?:\/[^@\s"]+)?)@/.exec(block);
        const version = /\n\s+"?version"?:?\s+"?([^"\s]+)"?/.exec(block);
        if (header && version && !resolved.has(header[1])) {
          resolved.set(header[1], version[1]);
        }
      }
    }

    return resolved;
  }

  async detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
  ): Promise<Toolchain> {
    const cwd = path.dirname(manifestPath);
    const manifestText = await ctx.readFile(manifestPath);
    const declared = manifestText
      ? /"packageManager"\s*:\s*"([a-z]+)@(\d+)?/.exec(manifestText)
      : null;

    const finish = async (id: ToolchainId): Promise<Toolchain> => ({
      id,
      ecosystem: 'node',
      cwd,
      ...(id === 'yarn'
        ? { yarnBerry: await isYarnBerry(cwd, declared?.[2], ctx) }
        : {}),
    });

    const preferred = ctx.preferredToolchain('node');
    if (preferred !== 'auto') {
      return finish(preferred as ToolchainId);
    }

    // `packageManager` is the project's own declaration and outranks lockfiles.
    if (declared && ['npm', 'yarn', 'pnpm', 'bun'].includes(declared[1])) {
      return finish(declared[1] as ToolchainId);
    }

    const checks: Array<[string, ToolchainId]> = [
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ];
    for (const [file, id] of checks) {
      if (await ctx.exists(path.join(cwd, file))) {
        return finish(id);
      }
    }

    return finish('npm');
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const registry = ctx.registryOverride('node') ?? DEFAULT_REGISTRY;

    return fetchVersionsWithCache(
      names,
      ctx,
      8,
      (name) => cacheKey('npm', 'versions', registry, name),
      async (name) => {
        const packument = await ctx.http.getJson<Packument>(
          `${registry}/${encodeName(name)}`,
          {
            signal,
            // The abbreviated document drops README and other bulk.
            headers: { Accept: 'application/vnd.npm.install-v1+json' },
          },
        );
        const versions = Object.keys(packument.versions ?? {});
        const latestTag = packument['dist-tags']?.latest;
        const latestVer = latestTag
          ? packument.versions?.[latestTag]
          : undefined;
        return {
          versions,
          latest: latestTag,
          deprecated: latestVer?.deprecated,
          sizeBytes: latestVer?.dist?.unpackedSize ?? latestVer?.dist?.size,
        };
      },
      // Names come straight from package.json, which is not ours to trust:
      // anything that is not a real npm name cannot resolve, and should not
      // be pasted into a URL to find that out. 404s are normal (private or
      // renamed packages); other failures (a malformed packument, a DNS
      // error) are just as unactionable per package, so every failure here
      // falls back to stale data rather than rejecting the whole batch and
      // losing results already fetched for sibling packages.
      (name) => this.isValidPackageName(name),
    );
  }

  async fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined> {
    const registry = ctx.registryOverride('node') ?? DEFAULT_REGISTRY;
    const key = cacheKey('npm', 'meta', registry, name);
    const cached = ctx.cache.get<PackageMeta>(key);
    if (cached) return cached;

    try {
      // The full version document, not the abbreviated packument: the
      // abbreviated form is install-oriented and carries none of the fields we
      // need here (repository, homepage, description).
      const version = await ctx.http.getJson<PackumentVersion>(
        `${registry}/${encodeName(name)}/latest`,
        { signal },
      );
      if (!version) return undefined;

      const repository = normalizeRepositoryUrl(
        typeof version.repository === 'string'
          ? version.repository
          : version.repository?.url,
      );

      const meta: PackageMeta = {
        name,
        description: version.description,
        homepage: version.homepage,
        repository,
        changelogUrl: changelogUrlFor(repository),
        sizeBytes: version.dist?.unpackedSize,
        deprecated: version.deprecated,
        author:
          typeof version.author === 'string'
            ? version.author
            : version.author?.name,
      };
      await ctx.cache.set(key, meta, TTL.metadata);
      return meta;
    } catch {
      return ctx.cache.getStale<PackageMeta>(key);
    }
  }

  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const registry = ctx.registryOverride('node') ?? DEFAULT_REGISTRY;
    const url = `${registry}/-/v1/search?text=${encodeURIComponent(query)}&size=25`;

    interface SearchResponse {
      objects: Array<{
        package: {
          name: string;
          version: string;
          description?: string;
          links?: { repository?: string };
        };
        downloads?: { weekly?: number };
      }>;
    }

    const response = await ctx.http.getJson<SearchResponse>(url, { signal });
    return response.objects.map((entry) => ({
      name: entry.package.name,
      version: entry.package.version,
      description: entry.package.description,
      ecosystem: 'node' as const,
      downloads: entry.downloads?.weekly,
      repository: normalizeRepositoryUrl(entry.package.links?.repository),
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

    const flags = scopeFlags(toolchain, scope);
    const verb = toolchain.id === 'npm' ? 'install' : 'add';
    const argv = [toolchain.id, verb, spec, ...flags];

    return {
      argv,
      cwd: toolchain.cwd,
      description: `Install ${spec}${scope === 'dev' ? ' as a dev dependency' : ''}`,
    };
  }

  updateCommand(
    toolchain: Toolchain,
    dep: Dependency,
    toVersion: string,
  ): Command | null {
    return this.installCommand(toolchain, dep.name, toVersion, dep.scope);
  }

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null {
    if (!this.isValidPackageName(dep.name)) return null;
    const verb = toolchain.id === 'npm' ? 'uninstall' : 'remove';
    return {
      argv: [toolchain.id, verb, dep.name],
      cwd: toolchain.cwd,
      description: `Uninstall ${dep.name}`,
    };
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    // Each of these respects the declared ranges rather than jumping majors,
    // which is the behaviour people expect from an "update all" button.
    //
    // The verb is not shared: npm, pnpm and bun spell it `update`, Yarn 1
    // spells it `upgrade`, and Yarn 2+ spells it `up`. `yarn update` has never
    // existed in either line.
    const argv =
      toolchain.id === 'yarn'
        ? ['yarn', toolchain.yarnBerry ? 'up' : 'upgrade']
        : [toolchain.id, 'update'];

    return {
      argv,
      cwd: toolchain.cwd,
      description: 'Update all dependencies within their declared ranges',
    };
  }
}

/**
 * The flag that files an install under the right dependency bucket.
 *
 * The four managers agree on almost nothing here. npm and pnpm use the
 * `--save-*` family; Yarn 1 and bun use the short forms; Yarn 2+ dropped
 * `--optional` and `--peer` in favour of `--optional`/`--peer` on `yarn add`
 * only for peer, so anything it cannot express is left to the manifest.
 */
function scopeFlags(toolchain: Toolchain, scope: DepScope): string[] {
  const savePrefixed = toolchain.id === 'npm' || toolchain.id === 'pnpm';

  switch (scope) {
    case 'dev':
      return savePrefixed ? ['--save-dev'] : ['--dev'];
    case 'optional':
      return savePrefixed ? ['--save-optional'] : ['--optional'];
    case 'peer':
      return savePrefixed ? ['--save-peer'] : ['--peer'];
    default:
      return [];
  }
}

/**
 * Distinguishes Yarn 2+ from Yarn 1.
 *
 * Three signals, cheapest first: the major in `packageManager`, the presence of
 * `.yarnrc.yml` (Berry-only — v1 used `.yarnrc`), and the `__metadata` block
 * Berry writes at the top of every lockfile it owns.
 */
async function isYarnBerry(
  cwd: string,
  declaredMajor: string | undefined,
  ctx: ProviderContext,
): Promise<boolean> {
  if (declaredMajor) return Number(declaredMajor) >= 2;
  if (await ctx.exists(path.join(cwd, '.yarnrc.yml'))) return true;

  const lock = await ctx.readFile(path.join(cwd, 'yarn.lock'));
  return lock ? /^__metadata:/m.test(lock) : false;
}

/** Encode scoped package names for npm registry API while preserving the leading '@'. */
function encodeName(name: string): string {
  return encodeURIComponent(name).replace(/^%40/, '@');
}
