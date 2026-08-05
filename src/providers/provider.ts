/**
 * The contract every ecosystem implements.
 *
 * Adding a language means adding one folder under `src/providers/` and
 * registering it in `registry.ts` — nothing above this layer changes.
 */

import type { TtlCache } from '../core/cache.js';
import type { HttpClient } from '../core/http.js';
import type {
  Dependency,
  DepScope,
  Ecosystem,
  PackageMeta,
  ParsedManifest,
  SearchResult,
  Toolchain,
  ToolchainId,
} from '../core/types.js';

export interface ProviderContext {
  http: HttpClient;
  cache: TtlCache;
  /** Reads a workspace file as UTF-8; resolves to null when absent. */
  readFile(absolutePath: string): Promise<string | null>;
  /** True when the path exists (file or directory). */
  exists(absolutePath: string): Promise<boolean>;
  /** Per-ecosystem registry base URL overrides from settings. */
  registryOverride(ecosystem: Ecosystem): string | undefined;
  /** User's forced toolchain choice, or 'auto'. */
  preferredToolchain(ecosystem: Ecosystem): string;
}

/** Version facts for a single package, as returned by a registry. */
export interface VersionInfo {
  /** Every published version, unsorted. */
  versions: string[];
  /** The registry's own notion of "latest", which may exclude prereleases. */
  latest?: string;
  /** Deprecation notice for the package as a whole. */
  deprecated?: string;
}

/** A command to run, expressed as argv so nothing is shell-interpolated. */
export interface Command {
  argv: string[];
  cwd: string;
  /** Shown to the user before the command runs. */
  description: string;
}

export interface EcosystemProvider {
  readonly id: Ecosystem;

  /** File names (not globs) this provider claims. */
  readonly manifestFiles: string[];

  /** Lockfiles worth watching for change, and parsing for resolved versions. */
  readonly lockFiles: string[];

  /** Validates a package name before it can reach a command line. */
  isValidPackageName(name: string): boolean;

  parse(
    absolutePath: string,
    text: string,
    ctx: ProviderContext,
  ): Promise<ParsedManifest>;

  /**
   * Reads resolved versions out of a lockfile, keyed by package name.
   * Returning an empty map is fine — the UI falls back to the constraint.
   */
  readLockfile?(
    manifestDir: string,
    ctx: ProviderContext,
  ): Promise<Map<string, string>>;

  detectToolchain(
    manifestPath: string,
    ctx: ProviderContext,
  ): Promise<Toolchain>;

  /** Batched version lookup. Implementations should respect `signal`. */
  fetchVersions(
    names: string[],
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<Map<string, VersionInfo>>;

  fetchMetadata(
    name: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<PackageMeta | undefined>;

  search(
    query: string,
    ctx: ProviderContext,
    signal?: AbortSignal,
  ): Promise<SearchResult[]>;

  /** The OSV.dev ecosystem string, when OSV covers this ecosystem. */
  readonly osvEcosystem?: string;

  /** The deps.dev system name, when deps.dev covers this ecosystem. */
  readonly depsDevSystem?: string;

  installCommand(
    toolchain: Toolchain,
    name: string,
    version: string | null,
    scope: DepScope,
  ): Command | null;

  updateCommand(
    toolchain: Toolchain,
    dep: Dependency,
    toVersion: string,
  ): Command | null;

  uninstallCommand(toolchain: Toolchain, dep: Dependency): Command | null;

  updateAllCommand(toolchain: Toolchain): Command | null;

  /**
   * Some ecosystems have no CLI for a given edit (requirements.txt pins, Maven
   * POM versions). Those providers implement this instead, returning the new
   * manifest text, and the host applies it as a WorkspaceEdit.
   */
  editManifest?(
    manifestText: string,
    edit:
      | { kind: 'add'; name: string; version: string | null; scope: DepScope }
      | { kind: 'update'; name: string; version: string; scope: DepScope }
      | { kind: 'remove'; name: string; scope: DepScope },
  ): string | null;
}

/** Maps an ecosystem's own scope vocabulary onto our five buckets. */
export function normalizeScope(raw: string): DepScope {
  const lower = raw.toLowerCase();
  if (lower.includes('dev') || lower === 'test' || lower === 'testing')
    return 'dev';
  if (lower === 'build' || lower === 'provided' || lower === 'compile-only')
    return 'build';
  if (lower.includes('optional')) return 'optional';
  if (lower.includes('peer')) return 'peer';
  return 'prod';
}

/** Builds the stable per-row identity the webview uses for selection. */
export function dependencyKey(
  manifestPath: string,
  scope: DepScope,
  name: string,
): string {
  return `${manifestPath}::${scope}::${name}`;
}

export function toolchainOf(
  id: ToolchainId,
  ecosystem: Ecosystem,
  cwd: string,
): Toolchain {
  return { id, ecosystem, cwd };
}
