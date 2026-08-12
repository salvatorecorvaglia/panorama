/**
 * Python: pyproject.toml (PEP 621, Poetry, or uv) and requirements.txt,
 * driven by pip, uv or poetry.
 *
 * Two things make Python harder than the rest:
 *  - PyPI has no official JSON search API, so exact-name lookup is the primary
 *    path and a cached PEP 691 name index backs prefix search.
 *  - Requirement strings carry extras and environment markers
 *    (`requests[security]>=2.0; python_version < "3.11"`), which must be
 *    stripped before the name is usable.
 */

import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
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
import { maxVersion } from '../../core/versions/index.js';
import {
  type Command,
  dependencyKey,
  type EcosystemProvider,
  normalizeScope,
  type ProviderContext,
  type VersionInfo,
} from '../provider.js';
import { mapWithConcurrency } from '../shared/concurrency.js';
import {
  changelogUrlFor,
  normalizeRepositoryUrl,
} from '../shared/repository.js';

const DEFAULT_INDEX = 'https://pypi.org';

/** PEP 508 names: letters, digits, and single -_. separators. */
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

interface PyPiResponse {
  info: {
    name: string;
    version: string;
    summary?: string;
    home_page?: string;
    yanked?: boolean;
    yanked_reason?: string;
    author?: string;
    project_urls?: Record<string, string>;
    requires_dist?: string[];
  };
  urls?: Array<{ size?: number; packagetype?: string }>;
}

/** PEP 691 simple index — the closest thing PyPI has to a package list. */
interface SimpleIndex {
  projects: Array<{ name: string }>;
}

export class PythonProvider implements EcosystemProvider {
  readonly id = 'python' as const;
  readonly manifestFiles = [
    'pyproject.toml',
    'requirements.txt',
    'requirements-dev.txt',
  ];
  readonly lockFiles = ['poetry.lock', 'uv.lock', 'Pipfile.lock'];
  readonly osvEcosystem = 'PyPI';
  readonly depsDevSystem = 'PYPI';

  isValidPackageName(name: string): boolean {
    return name.length <= 214 && NAME_PATTERN.test(name);
  }

  /** PEP 503: what `readLockfile` keys by, so the scanner can match manifests. */
  normalizeName(name: string): string {
    return normalizeName(name);
  }

  async parse(
    absolutePath: string,
    text: string,
    _ctx: ProviderContext,
  ): Promise<ParsedManifest> {
    const base = path.basename(absolutePath);
    return base === 'pyproject.toml'
      ? this.parsePyproject(absolutePath, text)
      : this.parseRequirements(absolutePath, text);
  }

  private parsePyproject(absolutePath: string, text: string): ParsedManifest {
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch {
      // Malformed TOML still gives us a manifest, just an empty one.
      return emptyManifest(absolutePath);
    }

    const project = doc.project as Record<string, unknown> | undefined;
    const tool = doc.tool as Record<string, unknown> | undefined;
    const poetry = tool?.poetry as Record<string, unknown> | undefined;

    const projectLabel =
      (project?.name as string) ??
      (poetry?.name as string) ??
      path.basename(path.dirname(absolutePath));

    const dependencies: Dependency[] = [];
    // A pyproject can declare the same package twice — PEP 621 and Poetry
    // tables coexist during a migration, and extras repeat their base
    // requirements. Two rows sharing a key break selection and React
    // reconciliation, so the first declaration wins.
    const seen = new Set<string>();

    const add = (name: string, declared: string, scope: DepScope) => {
      if (!name) return;
      const key = dependencyKey(absolutePath, scope, normalizeName(name));
      if (seen.has(key)) return;
      seen.add(key);

      dependencies.push({
        key,
        name,
        ecosystem: 'python',
        scope,
        declared,
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        projectLabel,
      });
    };

    // PEP 621: project.dependencies is a list of requirement strings.
    for (const entry of (project?.dependencies as string[] | undefined) ?? []) {
      const parsed = parseRequirement(entry);
      if (parsed) add(parsed.name, parsed.specifier, 'prod');
    }

    // PEP 735 / setuptools: optional-dependencies is a table of extras.
    const optional = project?.['optional-dependencies'] as
      | Record<string, string[]>
      | undefined;
    for (const [group, entries] of Object.entries(optional ?? {})) {
      const scope = normalizeScope(group);
      for (const entry of entries) {
        const parsed = parseRequirement(entry);
        if (parsed) add(parsed.name, parsed.specifier, scope);
      }
    }

    // PEP 735 dependency-groups (uv, pip 25+).
    const groups = doc['dependency-groups'] as
      | Record<string, unknown[]>
      | undefined;
    for (const [group, entries] of Object.entries(groups ?? {})) {
      const scope = normalizeScope(group);
      for (const entry of entries) {
        if (typeof entry !== 'string') continue; // skip {include-group = ...}
        const parsed = parseRequirement(entry);
        if (parsed) add(parsed.name, parsed.specifier, scope);
      }
    }

    // Poetry uses tables keyed by name, with either a string or a table value.
    const poetryDeps = poetry?.dependencies as
      | Record<string, unknown>
      | undefined;
    for (const [name, value] of Object.entries(poetryDeps ?? {})) {
      if (name.toLowerCase() === 'python') continue; // the interpreter, not a package
      add(name, poetryConstraint(value), 'prod');
    }
    const poetryGroups = poetry?.group as
      | Record<string, { dependencies?: Record<string, unknown> }>
      | undefined;
    for (const [group, body] of Object.entries(poetryGroups ?? {})) {
      const scope = normalizeScope(group);
      for (const [name, value] of Object.entries(body.dependencies ?? {})) {
        add(name, poetryConstraint(value), scope);
      }
    }
    // Poetry's pre-1.2 dev group.
    const legacyDev = poetry?.['dev-dependencies'] as
      | Record<string, unknown>
      | undefined;
    for (const [name, value] of Object.entries(legacyDev ?? {})) {
      add(name, poetryConstraint(value), 'dev');
    }

    // uv workspace members.
    const uv = tool?.uv as Record<string, unknown> | undefined;
    const workspace = uv?.workspace as { members?: string[] } | undefined;

    return {
      ecosystem: 'python',
      path: absolutePath,
      name: projectLabel,
      dependencies,
      workspaceMembers: workspace?.members,
      isWorkspaceRoot:
        (workspace?.members?.length ?? 0) > 0 && dependencies.length === 0,
    };
  }

  private parseRequirements(
    absolutePath: string,
    text: string,
  ): ParsedManifest {
    const projectLabel = path.basename(path.dirname(absolutePath));
    // Convention: a file named *dev* holds dev dependencies.
    const scope: DepScope = /dev|test/i.test(path.basename(absolutePath))
      ? 'dev'
      : 'prod';
    const dependencies: Dependency[] = [];

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      if (line === '') continue;
      // Skip includes, editable installs, index URLs and bare flags.
      if (line.startsWith('-') || line.startsWith('--')) continue;
      // Skip direct URLs and local paths, which have no registry version.
      if (
        /^[a-z]+:\/\//i.test(line) ||
        line.startsWith('.') ||
        line.startsWith('/')
      )
        continue;

      const parsed = parseRequirement(line);
      if (!parsed) continue;

      dependencies.push({
        key: dependencyKey(absolutePath, scope, parsed.name),
        name: parsed.name,
        ecosystem: 'python',
        scope,
        declared: parsed.specifier,
        updateKind: 'unknown',
        vulnerabilities: [],
        manifestPath: absolutePath,
        projectLabel,
      });
    }

    return {
      ecosystem: 'python',
      path: absolutePath,
      name: projectLabel,
      dependencies,
    };
  }

  async readLockfile(
    manifestDir: string,
    ctx: ProviderContext,
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();

    for (const lockName of ['uv.lock', 'poetry.lock']) {
      const text = await ctx.readFile(path.join(manifestDir, lockName));
      if (!text) continue;
      try {
        // Both are TOML with an array of [[package]] tables.
        const doc = parseToml(text) as {
          package?: Array<{ name?: string; version?: string }>;
        };
        for (const entry of doc.package ?? []) {
          if (entry.name && entry.version) {
            resolved.set(normalizeName(entry.name), entry.version);
          }
        }
      } catch {
        // Fall through; an unreadable lockfile just means no resolved versions.
      }
      if (resolved.size > 0) return resolved;
    }

    return resolved;
  }

  async detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
  ): Promise<Toolchain> {
    const cwd = path.dirname(manifestPath);
    const preferred = ctx.preferredToolchain('python');

    const venvPath = await this.findVenv(cwd, ctx);
    const base = {
      ecosystem: 'python' as const,
      cwd,
      venvPath,
      manifestFile: path.basename(manifestPath),
    };

    if (preferred !== 'auto') {
      return { ...base, id: preferred as ToolchainId };
    }

    if (await ctx.exists(path.join(cwd, 'uv.lock')))
      return { ...base, id: 'uv' };
    if (await ctx.exists(path.join(cwd, 'poetry.lock')))
      return { ...base, id: 'poetry' };

    // No lockfile — fall back to what pyproject.toml declares.
    const pyproject = await ctx.readFile(path.join(cwd, 'pyproject.toml'));
    if (pyproject) {
      if (/\[tool\.poetry\]/.test(pyproject)) return { ...base, id: 'poetry' };
      if (/\[tool\.uv\]/.test(pyproject)) return { ...base, id: 'uv' };
    }

    return { ...base, id: 'pip' };
  }

  private async findVenv(
    dir: string,
    ctx: ProviderContext,
  ): Promise<string | undefined> {
    // An activated environment wins over anything on disk.
    const active = process.env.VIRTUAL_ENV;
    if (active) return active;
    for (const candidate of ['.venv', 'venv', 'env']) {
      const full = path.join(dir, candidate);
      if (await ctx.exists(path.join(full, 'pyvenv.cfg'))) return full;
    }
    return undefined;
  }

  async fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>> {
    const index = ctx.registryOverride('python') ?? DEFAULT_INDEX;
    const result = new Map<string, VersionInfo>();

    await mapWithConcurrency(names, 8, async (name) => {
      const key = cacheKey('pypi', 'versions', index, name);
      const cached = ctx.cache.get<VersionInfo>(key);
      if (cached) {
        result.set(name, cached);
        return;
      }

      try {
        // The PEP 691 simple endpoint is the supported source for the version
        // list; the legacy JSON `releases` key is deprecated.
        const simple = await ctx.http.getJson<{ versions?: string[] }>(
          `${index}/simple/${encodeURIComponent(normalizeName(name))}/`,
          {
            signal,
            headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
          },
        );
        const versions = simple.versions ?? [];
        const info: VersionInfo = { versions };
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
    const index = ctx.registryOverride('python') ?? DEFAULT_INDEX;
    const key = cacheKey('pypi', 'meta', index, name);
    const cached = ctx.cache.get<PackageMeta>(key);
    if (cached) return cached;

    try {
      const response = await ctx.http.getJson<PyPiResponse>(
        `${index}/pypi/${encodeURIComponent(name)}/json`,
        { signal },
      );
      const urls = response.info.project_urls ?? {};
      const repository = normalizeRepositoryUrl(
        urls.Source ??
          urls.Repository ??
          urls['Source Code'] ??
          urls.Homepage ??
          response.info.home_page,
      );
      // Prefer the wheel's size; sdists are misleadingly large.
      const wheel = response.urls?.find(
        (entry) => entry.packagetype === 'bdist_wheel',
      );

      const meta: PackageMeta = {
        name: response.info.name,
        description: response.info.summary,
        homepage: response.info.home_page,
        repository,
        changelogUrl:
          urls.Changelog ?? urls.Changes ?? changelogUrlFor(repository),
        sizeBytes: wheel?.size ?? response.urls?.[0]?.size,
        deprecated: response.info.yanked
          ? `Yanked from PyPI${response.info.yanked_reason ? `: ${response.info.yanked_reason}` : ''}`
          : undefined,
        author: response.info.author,
      };
      await ctx.cache.set(key, meta, TTL.metadata);
      return meta;
    } catch {
      return ctx.cache.getStale<PackageMeta>(key);
    }
  }

  /**
   * PyPI has no search API. We try an exact-name hit first (the common case
   * when someone types a package they already know), then fall back to
   * substring matching over the cached PEP 691 project index.
   */
  async search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const index = ctx.registryOverride('python') ?? DEFAULT_INDEX;
    const results: SearchResult[] = [];

    const exact = await this.fetchMetadata(query, ctx, signal).catch(
      () => undefined,
    );
    if (exact) {
      const versions = await this.fetchVersions([query], ctx, signal);
      results.push({
        name: exact.name,
        // Ordered by PEP 440, not by position. The simple index makes no
        // promise about the order of `versions`, so taking the last entry
        // offered — and installed — whatever PyPI happened to list last,
        // which can be an old patch release or a prerelease.
        version:
          maxVersion('python', versions.get(query)?.versions ?? []) ?? '',
        description: exact.description,
        ecosystem: 'python',
        deprecated: exact.deprecated,
        repository: exact.repository,
      });
    }

    const names = await this.projectIndex(index, ctx, signal);
    const needle = normalizeName(query);
    const matches = names
      .filter((name) => name.includes(needle) && name !== needle)
      // Prefix matches are far more relevant than substring matches.
      .sort((a, b) => {
        const aPrefix = a.startsWith(needle) ? 0 : 1;
        const bPrefix = b.startsWith(needle) ? 0 : 1;
        return aPrefix - bPrefix || a.length - b.length;
      })
      .slice(0, 24);

    for (const name of matches) {
      results.push({ name, version: '', ecosystem: 'python' });
    }

    return results;
  }

  /**
   * Downloads and caches the full PyPI project list (large, so daily at most).
   *
   * Held in memory only. The index is over half a million names, and
   * `globalState` is a JSON blob VS Code loads and rewrites synchronously —
   * persisting this made every subsequent extension-host start pay for a search
   * the user may have run once. Re-fetching it after a reload costs one request
   * on the next search instead.
   */
  private async projectIndex(
    index: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const key = cacheKey('pypi', 'index', index);
    const cached = ctx.cache.get<string[]>(key);
    if (cached) return cached;

    try {
      const response = await ctx.http.getJson<SimpleIndex>(`${index}/simple/`, {
        signal,
        headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
        timeoutMs: 60_000,
        /*
         * Keeping this out of `globalState` is only half the job: the ETag
         * cache in `http.ts` retains full response bodies, so revalidating a
         * tens-of-megabyte document would pin the raw JSON in memory for the
         * life of the window — undoing `persist: false` one layer down. The
         * parsed name list above is the copy worth keeping.
         */
        noCache: true,
      });
      const names = response.projects.map((entry) => normalizeName(entry.name));
      await ctx.cache.set(key, names, TTL.nameIndex, { persist: false });
      return names;
    } catch {
      return ctx.cache.getStale<string[]>(key) ?? [];
    }
  }

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null {
    if (!this.isValidPackageName(name)) return null;
    const spec = version ? `${name}==${version}` : name;
    const isDev = scope === 'dev' || scope === 'build';

    switch (toolchain.id) {
      case 'uv':
        return {
          argv: ['uv', 'add', ...(isDev ? ['--dev'] : []), spec],
          cwd: toolchain.cwd,
          description: `Add ${spec} with uv`,
        };
      case 'poetry':
        return {
          argv: ['poetry', 'add', ...(isDev ? ['--group', 'dev'] : []), spec],
          cwd: toolchain.cwd,
          description: `Add ${spec} with Poetry`,
        };
      default:
        // pip installs into the environment and writes nothing back, so the
        // host pairs this with an `editManifest` call.
        return {
          argv: [pythonExe(toolchain), '-m', 'pip', 'install', spec],
          cwd: toolchain.cwd,
          description: `Install ${spec} with pip`,
          writesManifest: false,
        };
    }
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
    switch (toolchain.id) {
      case 'uv':
        return {
          argv: [
            'uv',
            'remove',
            ...(dep.scope === 'dev' ? ['--dev'] : []),
            dep.name,
          ],
          cwd: toolchain.cwd,
          description: `Remove ${dep.name} with uv`,
        };
      case 'poetry':
        return {
          argv: [
            'poetry',
            'remove',
            ...(dep.scope === 'dev' ? ['--group', 'dev'] : []),
            dep.name,
          ],
          cwd: toolchain.cwd,
          description: `Remove ${dep.name} with Poetry`,
        };
      default:
        return {
          argv: [
            pythonExe(toolchain),
            '-m',
            'pip',
            'uninstall',
            '-y',
            dep.name,
          ],
          cwd: toolchain.cwd,
          description: `Uninstall ${dep.name} with pip`,
          writesManifest: false,
        };
    }
  }

  updateAllCommand(toolchain: Toolchain): Command | null {
    switch (toolchain.id) {
      case 'uv':
        return {
          argv: ['uv', 'lock', '--upgrade'],
          cwd: toolchain.cwd,
          description: 'Upgrade all locked versions with uv',
        };
      case 'poetry':
        return {
          argv: ['poetry', 'update'],
          cwd: toolchain.cwd,
          description: 'Update all with Poetry',
        };
      default: {
        // pip has no "update all"; the requirements file is the source of
        // truth. It is named from the manifest rather than assumed, so a
        // project driven by `requirements-dev.txt` does not silently reinstall
        // a `requirements.txt` that may not even exist.
        const requirements = toolchain.manifestFile ?? 'requirements.txt';
        return {
          argv: [
            pythonExe(toolchain),
            '-m',
            'pip',
            'install',
            '--upgrade',
            '-r',
            requirements,
          ],
          cwd: toolchain.cwd,
          description: `Reinstall ${requirements} with upgrades`,
        };
      }
    }
  }

  /**
   * requirements.txt has no CLI that can rewrite a pin, so we edit it directly —
   * line by line, preserving comments, ordering and unrelated flags.
   */
  editManifest(
    manifestText: string,
    edit:
      | { kind: 'add'; name: string; version: string | null; scope: DepScope }
      | { kind: 'update'; name: string; version: string; scope: DepScope }
      | { kind: 'remove'; name: string; scope: DepScope },
  ): string | null {
    const lines = manifestText.split(/\r?\n/);
    const target = normalizeName(edit.name);

    const indexOfDep = lines.findIndex((line) => {
      const bare = line.split('#')[0].trim();
      if (bare === '' || bare.startsWith('-')) return false;
      const parsed = parseRequirement(bare);
      return parsed ? normalizeName(parsed.name) === target : false;
    });

    if (edit.kind === 'remove') {
      if (indexOfDep === -1) return null;
      lines.splice(indexOfDep, 1);
      return lines.join('\n');
    }

    const pinned = edit.version ? `${edit.name}==${edit.version}` : edit.name;

    if (indexOfDep === -1) {
      if (edit.kind === 'update') return null;
      // Append, keeping exactly one trailing newline.
      while (lines.length > 0 && lines[lines.length - 1].trim() === '')
        lines.pop();
      lines.push(pinned, '');
      return lines.join('\n');
    }

    // Preserve any trailing comment on the line we are replacing.
    const original = lines[indexOfDep];
    const commentIndex = original.indexOf('#');
    const comment =
      commentIndex >= 0 ? `  ${original.slice(commentIndex)}` : '';
    lines[indexOfDep] = pinned + comment;
    return lines.join('\n');
  }
}

function pythonExe(toolchain: Toolchain): string {
  // Windows ships `python`; `python3` exists on POSIX and is the safer name
  // there, where `python` may still be a Python 2 interpreter.
  if (!toolchain.venvPath) {
    return process.platform === 'win32' ? 'python' : 'python3';
  }
  // Windows venvs put the interpreter in Scripts/, POSIX in bin/.
  return process.platform === 'win32'
    ? path.join(toolchain.venvPath, 'Scripts', 'python.exe')
    : path.join(toolchain.venvPath, 'bin', 'python');
}

/** PEP 503 name normalisation: lowercase, runs of -_. collapse to a hyphen. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Splits a PEP 508 requirement into name and specifier, discarding extras and
 * environment markers.
 */
export function parseRequirement(
  input: string,
): { name: string; specifier: string; extras: string[] } | null {
  // Drop the environment marker.
  const withoutMarker = input.split(';')[0].trim();
  if (withoutMarker === '') return null;

  const match =
    /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(
      withoutMarker,
    );
  if (!match) return null;

  return {
    name: match[1],
    extras: match[2] ? match[2].split(',').map((extra) => extra.trim()) : [],
    specifier: match[3].trim(),
  };
}

/** Poetry values may be a string constraint or a table with a `version` key. */
function poetryConstraint(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'version' in value) {
    return String((value as { version: unknown }).version);
  }
  return '*';
}

function emptyManifest(absolutePath: string): ParsedManifest {
  return {
    ecosystem: 'python',
    path: absolutePath,
    name: path.basename(path.dirname(absolutePath)),
    dependencies: [],
  };
}
