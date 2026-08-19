# Panorama 🔭

**Universal Visual Package Manager for Visual Studio Code**

**Panorama** provides a unified, visual, multi-ecosystem package management experience directly inside VS Code.

---

## ✨ Features

- 🌐 **Universal Multi-Ecosystem Support**: Native parsing for `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle`, and `build.gradle.kts`.
- ⚡ **Panel-First Interface**:
  - **React Webview Panel** (`panorama.open`): Interactive, virtualized UI built with React, Vite, and TanStack Virtual for deep dependency analysis, search, sorting, and filtering. This is where dependencies are read and acted on.
  - **Activity Bar View** (`panorama.sidebar`): A compact launcher for the panel. Its title bar carries the toolbar actions — open, search, check updates, refresh and update all — so they are one click away without the panel being open.
- 🛡️ **Security Vulnerability Audits**: Automated security scans powered by [OSV.dev](https://osv.dev) to detect known CVEs and advisories affecting your direct and transitive dependencies.
- 🔄 **Smart Update Checks & One-Click Upgrades**: Highlights outdated packages with semver diff indicators (`major`, `minor`, `patch`) and updates dependencies directly from the interface.
- 📏 **Package Size Tracking**: Tracks unpacked size or download size for packages across Node (npm), Rust (Cargo), and Python (PyPI) registries.

- 🔍 **Registry Search & Package Installation**: Search public registries (npm, PyPI, Crates.io, Packagist, Maven Central) and install packages into your manifests without leaving VS Code.
- 🌲 **"Why Is This Installed?" Dependency Inspector**: Inspect transitive dependencies and trace exact resolution paths.
- 📁 **Monorepo & Multi-Root Support**: Automatically discovers and aggregates nested manifest files across complex monorepos and multi-root workspaces with `.gitignore` and glob exclusion awareness.
- ♿ **Accessible & Keyboard-First UI**: Roving `tabindex` table navigation, global `Ctrl+F` / `Cmd+F` search shortcut, dismissable overlays (`Escape` key & backdrop dismissal for drawers/modals), ARIA live progress indicators, and high-contrast theme focus rings.
- 🚀 **High Performance & Shared Caching**: Built-in HTTP caching layer across registry queries and concurrent background manifest scanning.
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

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📜 Changelog

Detailed release history and version changes can be found in [CHANGELOG.md](CHANGELOG.md).

## 🔐 Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md).

## 📝 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

**Author**: [Salvatore Corvaglia](https://github.com/salvatorecorvaglia)