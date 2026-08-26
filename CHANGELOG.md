# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Inline Update & Vulnerability CodeLenses**: Manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle(.kts)`) now show a CodeLens above each dependency with an available update and/or known vulnerabilities, so that status is visible without opening the Panorama panel. Clicking a lens opens the panel on that dependency's details.
- **Vulnerability Diagnostics**: Dependencies with known vulnerabilities are now also reported as Problems-panel diagnostics on their declaration line, for open manifest files.
- **Duplicate Version Detection**: A new "Duplicate versions" panel checks each project's lockfile (npm, pnpm, yarn, Cargo, Composer, poetry/uv) for packages resolved at more than one version at once, listing every project and version group found. Go, Maven and Gradle are reported as unchecked rather than clean, since none has a lockfile Panorama can trust for this.
- **Export Dependency Report**: A new "Export report" action (toolbar button and `panorama.exportReport` command) writes the current scan — outdated packages, known vulnerabilities and duplicate versions, per project — to a Markdown or JSON file the user chooses, for sharing outside the editor or attaching to a PR.
- **License Metadata & Policy**: Package metadata now includes the registry-reported license (npm, PyPI, Crates.io, Packagist), shown in the dependency detail drawer. A new "License summary" panel checks every unique package in the workspace and groups them by license, flagging any that violate the new `panorama.licenseAllowList`/`licenseDenyList` settings. Go, Maven and Gradle packages are grouped as unknown rather than guessed, since none of their registries expose a license Panorama can attribute with confidence.
- **Authenticated Registry Overrides**: `panorama.registryOverrides` entries can now be an object naming an environment variable that holds a bearer token for that registry (e.g. `{ "npm": { "url": "https://registry.mycompany.com", "tokenEnvVar": "COMPANY_NPM_TOKEN" } }`), for private registries (Artifactory, Nexus, GitHub Packages, private PyPI/Packagist mirrors, ...) that require authentication. The token is read from the named environment variable at request time and is never written to settings or any other Panorama-managed storage; it is also never sent unless the configured URL passes the same scheme validation the existing unauthenticated override already requires, so a malformed override can never leak a token to the public registry. Supported by all seven providers.

## [2.5.0] - 2026-08-25

### Added

- **Custom Registry Overrides for All Providers**: Extended `panorama.registryOverrides` support to Cargo, Composer, Go, and Maven/Gradle (previously limited to npm and PyPI), so a private registry or mirror can be configured for every ecosystem.
- **Workspace Trust Support**: Declared the `untrustedWorkspaces` capability in `package.json`, restricting `panorama.registryOverrides` so it is not read from an untrusted workspace's settings.
- **Update Preserves the Declared Version Range Operator**: Updating a Node dependency now carries the manifest's existing `^`/`~` prefix onto the new version (`applyDeclaredPrefix`) instead of silently pinning an exact version.
- **CI Verify Gate on Release**: `release.yml` now runs lint, typecheck, and unit tests in a dedicated `Verify` job that `Release` depends on.
- **Registry Rate Limits for PyPI & the Go Proxy**: Added self-imposed per-host rate limits for `pypi.org` and `proxy.golang.org`, matching the existing limits for Maven Central, Packagist, and OSV.dev.
- **Expanded Test Coverage**: Added integration tests for `DependencyMutator`, `PanelManager`, and `SidebarViewProvider`, and unit tests for `TtlCache`, `depGraph`, `registryOverride`, provider input validation, and shell quoting.

### Fixed

- **`pnpm-lock.yaml` Parsed with a Real YAML Parser**: `NodeProvider` and the "why is this installed" dependency graph (`core/depGraph.ts`) now parse `pnpm-lock.yaml` with the `yaml` package instead of regex/indentation scanning, correctly separating the `importers:` block from `packages:`/`snapshots:` and fixing resolution on lockfiles the hand-rolled parser used to get wrong.
- **Lazily Fetched Metadata Not Rendering**: Description, license, and size metadata fetched after the initial scan and merged into an existing row could be silently dropped by the virtualized table's row memoization, since the underlying dependency object is mutated in place rather than replaced. Rows now re-render when their metadata arrives.
- **Windows Command Injection via Crafted Version Strings**: cmd.exe's `.cmd`/`.bat` wrappers — what npm/yarn/pnpm are on Windows — treat unquoted `,` and `=` as argument delimiters, and `!VAR!` expands under delayed expansion. Both are now stripped/rejected by the shell-quoting layer so a malicious registry response cannot smuggle extra arguments into an install or update command.
- **PEP 440 Epoch Versions in Vulnerability Matching**: `constraintToApproxVersion`, whose result feeds the OSV.dev audit match, previously returned just the epoch digit for a constraint like `1!2.0.0`; it now correctly returns `2.0.0`.
- **Table Sort: Missing Sizes**: Rows without size metadata now sort last in ascending size order, matching the convention used for missing version data, instead of sorting first.
- **Sidebar Theme Colors**: Replaced hardcoded hex colors and a typo'd `--vscode-sidebar-background` token in `SidebarViewProvider` with the correct VS Code theme tokens (`--vscode-badge-*`, `--vscode-button-*`, `--vscode-sideBar-background`), fixing contrast in custom and high-contrast themes.
- **Manifest Edit Race**: `DependencyMutator` now checks that the document version hasn't changed between reading and applying a manifest edit, and no longer force-saves a manifest the user already had unrelated unsaved changes open in.
- **Cache Pruning Failures No Longer Abort the Sweep**: A single failed storage write during `TtlCache.prune()` no longer stops the rest of the sweep, and a lapsed in-memory entry is now evicted on read rather than lingering until pushed out by the LRU count bound.
- **Unhandled Rejection on Activation**: `cache.prune()` errors during extension activation are now caught instead of becoming an unhandled promise rejection.

### Accessibility

- **Search & Install Disabled Reason**: The reason an "Install" button is disabled (wrong ecosystem, no target manifest) is now also exposed via `aria-describedby`, not only a `title` tooltip a keyboard or screen-reader user cannot reach.

### Changed

- **Metadata Caching Deduplicated**: Node, Cargo, Composer, and Python providers now share a single `fetchMetadataWithCache` helper instead of each re-implementing the same cache-first, stale-on-failure logic.
- **Per-Ecosystem Maven Version Cache Keys**: Maven and Gradle version lookups are now cached under separate keys so a registry override on one no longer serves cached results to the other.
- **Queued Error Toasts Capped**: The webview's error notification queue is capped at 50 entries so a broken registry during a large bulk update can't grow it without bound.

### Removed

- **Dead Scanner Cancellation Code**: Removed `Scanner.cancel()` and its `inFlight` guard — `ScanQueue` is the only caller and never overlaps scans, so the guard was unreachable.
- **Unused `toolchainOf` Helper**: Removed the unused `toolchainOf()` export and its `ToolchainId` import from `providers/provider.ts`.

## [2.4.0] - 2026-08-20

### Added

- **Provider Dependency Management Unit Test Suite**: Added dedicated unit tests (`tests/unit/providerCommands.test.ts`) validating command generation (`installCommand`, `uninstallCommand`, `updateCommand`) across all 6 ecosystem providers (`Cargo`, `Composer`, `Go`, `Gradle`, `Node`, `Python`).
- **Webview CSS Module Declarations**: Added ambient CSS module declarations (`src/webview/env.d.ts`) and configured global DOM / Vitest test types in `tsconfig.json`.

### Fixed

- **`pnpm-lock.yaml` Resolution Priority**: Fixed version resolution in `NodeProvider` (`src/providers/node/index.ts`) so direct dependency version specifiers declared under `importers` take priority over transitive package definitions.
- **`package-lock.json` Top-Level Precedence**: Enhanced `package-lock.json` parsing to ensure direct top-level `node_modules` paths take precedence over nested transitive entries.
- **Cross-Platform Python Binary Selection**: Standardized Python executable binary selection (`python` on Windows vs `python3` on POSIX environments) for `pip` command execution in `PythonProvider`.

### Changed

- **Dependencies & Toolchain Upgrades**: Upgraded core framework and build tools including React 19 (`^19.2.8`), TypeScript 7 (`^7.0.2`), Vite 8 (`^8.2.2`), Vitest 4 (`^4.1.11`), `@types/node` (`^26.2.0`), `@types/react` (`^19.2.18`), and Biome (`^2.5.9`).
- **Integration Test TSConfig Clean-up**: Removed obsolete `moduleResolution` setting from `tsconfig.integration.json`.

## [2.3.0] - 2026-08-19

### Added

- **`DependencyMutator` Service**: Decoupled package update and uninstall command orchestration from `PanelManager` into a dedicated `DependencyMutator` service layer (`src/ui/dependencyMutator.ts`).
- **Shared Registry Caching (`cachedFetch`)**: Added a unified HTTP caching and request handler (`src/providers/shared/cachedFetch.ts`) across all ecosystem providers (Cargo, Composer, Go, Gradle, Node, Python) to optimize registry lookups and standardize header management.
- **`useDismissableOverlay` Custom Hook**: Added custom React hook (`src/webview/useDismissableOverlay.ts`) to centralize `Escape` key listener, backdrop click detection, and focus management across webview overlay components (`DetailDrawer` and `SearchInstall`).
- **Comprehensive Integration & Webview Test Suites**: Added new integration test coverage for terminal execution (`terminalRunner.test.ts`), workspace file watching (`watcher.test.ts`), webview security & CSP policies (`webviewSecurity.test.ts`), scanner exclusion rules (`scannerExclusions.test.ts`), webview table rendering (`DepTable.test.tsx`), and VS Code API communication (`vscodeApi.test.tsx`).

### Changed

- **Refactored `PanelManager`**: Streamlined webview panel lifecycle management, state synchronization, and message routing by delegating mutation logic to `DependencyMutator`.
- **Enhanced Workspace Manifest Scanner**: Improved `src/core/workspaces.ts` and `src/core/scanQueue.ts` to strictly observe nested `.gitignore` files and workspace glob exclusions during manifest file discovery.
- **Dependency & Build Maintenance**: Updated devDependencies (Biome, Testing Library) and added `minimumReleaseAgeExclude` configurations in `pnpm-workspace.yaml`.

## [2.2.0] - 2026-08-18

### Added

- **GitHub Project References Panel in Left Sidebar**: Added interactive project reference card, quick action links (Star on GitHub, Report an Issue, Release Notes, MIT License), and author credits in `SidebarViewProvider`.
- **Floating Bulk Action Bar**: Redesigned selection toolbar into a floating card centered at the bottom of the webview with backdrop blur and smooth shadow.
- **KPI Summary Pills & Filter Indicators**: Converted header summary text into status KPI pills with colored dot indicators, and added colored indicator dots to filter chips (`outdated`, `vulnerable`, `deprecated`).
- **Native Codicon Icons Integration**: Added VS Code Codicon icons to webview toolbar buttons (`Add package`, `Check updates`, `Refresh`) and row actions (`Update`, `Remove`).

### Changed

- **Deterministic CSS Grid Table Layout**: Converted dependency table header and data rows to a unified 7-track CSS Grid layout (`grid-template-columns`), eliminating layout calculation mismatches and scrollbar gutter offsets between headers and virtualized body rows.
- **Unified Left Alignment for Table Columns**: Standardized header and data cell alignment to left-aligned across all table columns (`Package`, `Scope`, `Current`, `Latest`, `Size`, `Status`, `Actions`) for consistent starting edge alignment.
- **Monospaced Data Cell Typography & Soft Badges**: Applied monospaced editor typography specifically to data cell versions and sizes while preserving header UI font, refreshed status badges with soft-tint backgrounds, and added directional version diff indicators.

## [2.1.0] - 2026-08-13

### Added

- **Package size tracking across providers**: Cargo (Crates.io `crate_size`), Node (npm `unpackedSize` / `size`), and Python (PyPI release file size) providers now fetch and expose package size metadata for installed and latest dependency versions.

### Changed

- **Dependency table UI layout & alignment**: Refined table header alignment for action cells (`.cell--actions`), enabled `scrollbar-gutter: stable` to prevent horizontal layout jumps during virtualization, and improved package name text truncation and size button positioning.


## [2.0.0] - 2026-08-13

### Fixed

- **Bulk actions no longer race**: "Update Selected" and "Remove Selected" sent one message per package, and the host handles messages concurrently — so a selection of ten stacked ten modal confirmations and ran ten package-manager commands at once through a single shared terminal. The selection now travels as one message (`bulkUpdate` / `bulkUninstall`), confirmed once and run in order, and `TerminalRunner` serialises commands regardless of caller.
- **"Update All" updated only the first project**: the toolbar button counted outdated packages across the whole workspace but always targeted `groups[0]`. With several projects it now asks which one, reusing the existing quick-pick.
- **Failed commands were silent**: a non-zero exit code from an install or update was discarded, leaving a refresh that appeared to do nothing. Failures now surface in the panel's error banner.
- **PyPI search offered the wrong version**: the version to install was taken as the last entry of the simple index's `versions` array, which is unordered. It is now the highest by PEP 440.
- **Integration tests never ran**: `.vscode-test.mjs` globbed `out/test/integration/**` while the build emits `out/tests/integration/**`, so Mocha matched nothing and exited 0. The 16 integration tests now run in CI.
- **Test fixtures shipped in the VSIX**: `.vscodeignore` excluded `test/**` rather than `tests/**`, publishing all eight fixture manifests inside the extension.

### Security

- **Sidebar webview hardened** to match the panel: CSP nonces now come from `randomBytes` rather than `Math.random`, external URLs are scheme-checked before being opened, and `localResourceRoots` is narrowed from the whole extension directory to `resources/`. Both surfaces share `ui/webviewSecurity.ts` so they cannot drift apart again.
- **Maven manifest writes are escaped**, and Maven gets a version grammar that rejects `<` and `>` while still accepting ranges like `[1.0,2.0)` — the shared grammar allows them because they are inert on a command line, but this is the one provider that writes into markup.
- Maven Central coordinates are URL-encoded in the search path, as they already were in the version lookup.

### Changed

- **Manifest scanning is concurrent** (8 at a time) and honours cancellation, instead of awaiting every file, sidecar, toolchain probe and lockfile one after another. Results are collected by position, so output is identical regardless of which read finishes first.
- **Maven Central version lookups run 5 at a time**, matching the rate limit already configured for the host, instead of strictly serially.
- The PyPI project index is fetched with `noCache`, so the tens-of-megabyte response body is no longer retained in the HTTP layer's revalidation cache for the life of the window.
- HTTP retries now share one deadline across the whole chain rather than each attempt getting a fresh timeout.
- **Every colour in the webview is a theme token again.** A block of hardcoded hex values had accumulated at the end of `theme.css` (and in the sidebar's inline styles), which broke contrast in light themes and ignored high-contrast ones. Added a `forced-colors` block.
- Go's `// indirect` requirements are labelled "indirect" rather than "optional", and Cargo's `workspace = true` reads as "inherited from workspace". Both corrections live in `core/vocabulary.ts`.
- The Activity Bar view is named "Panorama" and documented as what it is — a launcher for the panel, not a second place to inspect dependencies.
- **CI/CD & Release Workflow**:
  - Updated GitHub Actions workflows (`ci.yml` and `release.yml`) for improved build reliability and release automation.
  - Upgraded Biome linter schema configuration and cleaned up whitespace across test suites.

### Accessibility

- The bulk-action bar was a non-row child of `role="grid"`, which invalidated the grid's structure. It is now a labelled toolbar outside the grid.
- The select-all checkbox reports an indeterminate state on a partial selection, names what it covers when a filter is applied, and no longer discards selections the filter is hiding. Selections are dropped when a rescan removes the package.
- The scan progress bar carries indeterminate progressbar semantics, and its textual label is no longer `aria-hidden`.

### Removed

- **Dead tree-view surface**: `ui/treeProvider.ts` and the `panorama.revealDependency` command were left unreferenced by the sidebar migration and have been deleted, along with ~100 lines of sidebar CSS for markup that does not exist and a duplicated PEP 503 name normaliser.
- **Mute List Functionality**:
  - Removed package muting capability across extension host, workspace state, webview toolbar, detail drawer, and commands (`panorama.toggleMute` and `panorama.clearMuted`).

## [1.2.0] - 2026-08-12

### Added

- **Modernized Webview Interface & Layout**:
  - Redesigned webview toolbar with improved controls, spacing, and visual grouping.
  - Enhanced dependency data table styling and typography for improved scanability.
  - Refreshed high-contrast, dark mode, and light mode visual themes in `theme.css`.

### Changed

- **Test Infrastructure Consolidation**:
  - Unified test directory layout by consolidating `test/` into `tests/`.
  - Updated build configurations (`tsconfig.json`, `tsconfig.integration.json`, `vitest.config.ts`, `biome.json`, and `package.json`) to reflect unified test structure.
- **Branding & Vector Assets**:
  - High-resolution SVG and PNG branding asset updates (`panorama.svg` and `panorama.png`).

## [1.1.0] - 2026-08-12

### Added

- **Keyboard Navigation & Accessibility**:
  - Global `Ctrl+F` / `Cmd+F` keyboard shortcut to focus and select the webview search filter input.
  - Roving `tabindex` and arrow key navigation support across dependency data tables and search result lists.
  - ARIA progress roles, live regions (`aria-live="polite"`), and semantic attributes for screen readers.
  - Grouped toolbar filter controls with enhanced keyboard focus styling and high-contrast theme support.
- **Error Notification Queuing**:
  - Error queuing toast alert system to manage and present multiple concurrent host/registry errors without silent dropping.
- **Branding & Visuals**:
  - Vector branding assets (`panorama.svg` and `panorama.png`) for extension sidebar icon and webview headers.

### Changed

- Enhanced registry provider abstraction with input validation and LRU cache eviction policies for dependency metadata and security vulnerability lookups.
- Standardized cross-platform path normalization across integration test helpers.

## [1.0.0] - 2026-08-10

### Added

- First implementation of Panorama.

[Unreleased]: https://github.com/salvatorecorvaglia/panorama/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/salvatorecorvaglia/panorama/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/salvatorecorvaglia/panorama/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/salvatorecorvaglia/panorama/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/salvatorecorvaglia/panorama/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/salvatorecorvaglia/panorama/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/salvatorecorvaglia/panorama/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/salvatorecorvaglia/panorama/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/salvatorecorvaglia/panorama/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/salvatorecorvaglia/panorama/releases/tag/v1.0.0