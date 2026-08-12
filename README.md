# Panorama 🔭

**Universal Visual Package Manager for Visual Studio Code**

**Panorama** provides a unified, visual, multi-ecosystem package management experience directly inside VS Code.

---

## ✨ Features

- 🌐 **Universal Multi-Ecosystem Support**: Native parsing for `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle`, and `build.gradle.kts`.
- ⚡ **Dual UI Interface**:
  - **Activity Bar Tree View** (`panorama.explorer`): Fast, lightweight view of your workspace dependencies with badge indicators for outdated packages.
  - **React Webview Panel** (`panorama.open`): Interactive, virtualized UI built with React, Vite, and TanStack Virtual for deep dependency analysis, search, sorting, and filtering.
- 🛡️ **Security Vulnerability Audits**: Automated security scans powered by [OSV.dev](https://osv.dev) to detect known CVEs and advisories affecting your direct and transitive dependencies.
- 🔄 **Smart Update Checks & One-Click Upgrades**: Highlights outdated packages with semver diff indicators (`major`, `minor`, `patch`) and updates dependencies directly from the interface.
- 🔍 **Registry Search & Package Installation**: Search public registries (npm, PyPI, Crates.io, Packagist, Maven Central) and install packages into your manifests without leaving VS Code.
- 🌲 **"Why Is This Installed?" Dependency Inspector**: Inspect transitive dependencies and trace exact resolution paths.
- 🔕 **Per-Workspace Package Muting**: Suppress update notifications for specific packages on a per-project basis.
- 📁 **Monorepo & Multi-Root Support**: Automatically discovers and aggregates nested manifest files across complex monorepos and multi-root workspaces.
- ♿ **Accessible & Keyboard-First UI**: Roving `tabindex` table navigation, global `Ctrl+F` / `Cmd+F` search shortcut, ARIA live progress indicators, and high-contrast theme focus rings.
- 🔔 **Error Notification Queue**: Queued toast notification system for managing host and registry errors without silent dropping.
- ⚙️ **Custom Registries & Proxy Overrides**: Configure private registries and custom `User-Agent` contact headers.

---

## 📦 Supported Ecosystems

| Ecosystem | Manifest Files | Supported Package Managers | Registries |
| :--- | :--- | :--- | :--- |
| **Node.js / JS** | `package.json` | `npm`, `yarn`, `pnpm`, `bun` | npm Registry |
| **Python** | `pyproject.toml`, `requirements.txt` | `pip`, `uv`, `poetry` | PyPI |
| **Rust** | `Cargo.toml` | `cargo` | Crates.io |
| **Go** | `go.mod` | `go` | Go Proxy / Index |
| **PHP** | `composer.json` | `composer` | Packagist |
| **Java / Kotlin** | `pom.xml`, `build.gradle`, `build.gradle.kts` | `maven`, `gradle` | Maven Central |

---

## 🚀 Getting Started

1. Open any project or workspace containing supported manifest files in VS Code.
2. Open Panorama:
   - Click on the **Panorama** icon in the Activity Bar.
   - Or open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **`Panorama: Open Dependency Panel`**.
3. Use the toolbar actions to check for updates, scan security vulnerabilities, or search and install new dependencies.

---

## 🕹️ Commands

Panorama contributes the following commands to VS Code (`Panorama` category):

| Command | Title | Description |
| :--- | :--- | :--- |
| `panorama.open` | **Open Dependency Panel** | Opens the interactive React Webview dependency management panel. |
| `panorama.refresh` | **Refresh Dependencies** | Rescans workspace manifest files and updates the dependency tree. |
| `panorama.checkUpdates` | **Check for Updates** | Queries package registries for newer dependency versions. |
| `panorama.updateAll` | **Update All Dependencies** | Upgrades all outdated dependencies in workspace manifests. |
| `panorama.searchInstall` | **Search & Install Package** | Opens the interactive registry search interface to find and add dependencies. |
| `panorama.showWhy` | **Why Is This Installed?** | Displays the dependency graph path explaining why a package is present. |
| `panorama.toggleMute` | **Mute/Unmute Updates** | Suppresses or restores update checks for the selected dependency, in this project only. |
| `panorama.clearMuted` | **Clear All Muted Packages** | Resets all muted package preferences in the active workspace. |
| `panorama.revealDependency` | **Reveal Package in Panel** | Focuses and highlights the selected dependency inside the interactive React webview panel. |

---

## ⚙️ Configuration Settings

Panorama can be customized via VS Code Settings (`settings.json` under the `panorama.` namespace):

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `panorama.autoCheckUpdates` | `boolean` | `true` | Automatically check registries for newer versions when the panel opens and when manifests change. |
| `panorama.checkIntervalMinutes` | `number` | `60` | Background re-check interval in minutes (set to `0` to disable periodic background checks). |
| `panorama.enableAudit` | `boolean` | `true` | Query OSV.dev for known security vulnerabilities affecting your dependencies. |
| `panorama.preferredNodeManager` | `string` | `"auto"` | Preferred Node.js package manager (`"auto"`, `"npm"`, `"yarn"`, `"pnpm"`, `"bun"`). |
| `panorama.pythonManager` | `string` | `"auto"` | Preferred Python package manager (`"auto"`, `"pip"`, `"uv"`, `"poetry"`). |
| `panorama.excludeGlobs` | `array` | `["**/node_modules/**", "**/.venv/**", ...]` | Glob patterns to skip when scanning workspace manifest files. |
| `panorama.registryOverrides` | `object` | `{}` | Custom base URLs for package registries per ecosystem (e.g. `{"npm": "https://registry.mycompany.com"}`). |
| `panorama.contactEmail` | `string` | `""` | Optional contact email included in the `User-Agent` HTTP header sent to registries. |

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and release guidelines.

## 📜 Changelog

Detailed release history and version changes can be found in [CHANGELOG.md](CHANGELOG.md).

## 🔐 Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md).

## 📝 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

**Author**: [Salvatore Corvaglia](https://github.com/salvatorecorvaglia)