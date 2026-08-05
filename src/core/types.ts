/**
 * Domain types shared by the extension host and the webview.
 *
 * Nothing in this file may import `vscode` — the webview bundle pulls these
 * types in and would break if it did.
 */

export type Ecosystem =
  | 'node'
  | 'python'
  | 'cargo'
  | 'golang'
  | 'composer'
  | 'maven'
  | 'gradle';

/** The package manager actually driving a given manifest. */
export type ToolchainId =
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'bun'
  | 'pip'
  | 'uv'
  | 'poetry'
  | 'cargo'
  | 'go'
  | 'composer'
  | 'maven'
  | 'gradle';

/**
 * Where a dependency is declared. Every ecosystem maps its own vocabulary onto
 * this set so the UI only ever has to reason about five buckets.
 */
export type DepScope = 'prod' | 'dev' | 'build' | 'optional' | 'peer';

/** How far behind a dependency is. `none` means it is current. */
export type UpdateKind = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export interface Toolchain {
  id: ToolchainId;
  ecosystem: Ecosystem;
  /** Absolute path the command should run in. */
  cwd: string;
  /** True when the manifest is a workspace member rather than the root. */
  isWorkspaceMember?: boolean;
  /** Python only: absolute path to the detected virtualenv, if any. */
  venvPath?: string;
  /**
   * Maven/Gradle only: the wrapper script to invoke instead of the bare tool.
   * A project that ships a wrapper pins its own build-tool version, so calling
   * the system `mvn`/`gradle` can use a different one than CI does.
   */
  wrapper?: string;
}

export interface Vulnerability {
  id: string;
  summary: string;
  severity: Severity;
  /** CVE / GHSA identifiers this advisory is also known by. */
  aliases: string[];
  /** First version that is not affected, when the advisory states one. */
  fixedVersion?: string;
  url: string;
}

/** Registry-sourced facts about a package, independent of any project. */
export interface PackageMeta {
  name: string;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  changelogUrl?: string;
  /** Unpacked size in bytes, where the registry reports it. */
  sizeBytes?: number;
  /** Deprecation notice text. Presence means the package is deprecated. */
  deprecated?: string;
  author?: string;
  /** Weekly/recent downloads, where the registry reports it. */
  downloads?: number;
}

export interface Dependency {
  /** Stable identity across refreshes: `${manifestPath}::${scope}::${name}`. */
  key: string;
  name: string;
  ecosystem: Ecosystem;
  scope: DepScope;
  /** The raw constraint as written in the manifest, e.g. `^18.2.0`. */
  declared: string;
  /** The concrete version currently resolved, when a lockfile tells us. */
  installed?: string;
  /** Highest published version satisfying `declared`. */
  wanted?: string;
  /** Highest published version overall. */
  latest?: string;
  updateKind: UpdateKind;
  meta?: PackageMeta;
  vulnerabilities: Vulnerability[];
  /** Absolute path of the manifest that declares this dependency. */
  manifestPath: string;
  /** Human label for the owning project, e.g. `packages/web`. */
  projectLabel: string;
  /** True when the registry lookup failed; the row renders in a muted state. */
  lookupFailed?: boolean;
  /**
   * True when the user has deliberately muted this update. Muted packages stay
   * visible but are excluded from the outdated counts.
   */
  muted?: boolean;
}

export interface ParsedManifest {
  ecosystem: Ecosystem;
  /** Absolute path of the manifest file. */
  path: string;
  /** Display name, from the manifest if it declares one. */
  name: string;
  dependencies: Dependency[];
  /** Absolute paths of workspace member manifests this file declares. */
  workspaceMembers?: string[];
  /** True when this manifest is purely a workspace root with no own deps. */
  isWorkspaceRoot?: boolean;
}

export interface ProjectGroup {
  label: string;
  manifestPath: string;
  ecosystem: Ecosystem;
  toolchain: ToolchainId;
  dependencies: Dependency[];
  /** True when this manifest declares workspace members. */
  isWorkspaceRoot?: boolean;
  /** Label of the workspace root this group belongs to, when it is a member. */
  workspaceRootLabel?: string;
}

export interface SearchResult {
  name: string;
  version: string;
  description?: string;
  ecosystem: Ecosystem;
  downloads?: number;
  deprecated?: string;
  repository?: string;
  /** Set by the host when the package already appears in a loaded manifest. */
  installedIn?: Array<{ manifestPath: string; projectLabel: string; declared: string; scope: DepScope }>;
}

/** A node in the "why is this installed" reverse-dependency tree. */
export interface DepNode {
  name: string;
  version?: string;
  /** The constraint the parent asked for. */
  requestedRange?: string;
  children: DepNode[];
  /** True when expansion stopped because of a cycle or the depth cap. */
  truncated?: boolean;
}

export interface ScanSummary {
  totalDependencies: number;
  outdated: number;
  vulnerable: number;
  deprecated: number;
  /** How many outdated packages are muted, and so excluded from `outdated`. */
  muted: number;
  /** True when results came from cache because the network was unreachable. */
  stale: boolean;
}
