# Contributing to Panorama 🔭

Thank you for your interest in contributing to **Panorama**! We welcome contributions, bug reports, feature requests, and documentation improvements from the community.

---

## 🛠️ Prerequisites

Before you start, ensure you have the following installed on your system:

- **Node.js**: `v22.13.0` or higher
- **pnpm**: `v11.17.0` or higher (managed via `packageManager` in `package.json`)
- **VS Code**: `v1.93.0` or higher (Panorama uses VS Code terminal shell integration APIs finalized in 1.93)

---

## 🏗️ Architecture Overview

Panorama is structured as a VS Code extension with a dual-layer architecture:

- **Extension Host (`src/`)**: Written in TypeScript and compiled with `esbuild`. Responsible for scanning manifest files, workspace file watching, package manager CLI execution, registry API queries, OSV.dev vulnerability auditing, sidebar view provider (`panorama.sidebar`), and webview panel message handling.
- **Webview UI (`src/webview/`)**: React application built with TypeScript, Vite, and TanStack Virtual (`@tanstack/react-virtual`). Rendered inside a VS Code Webview panel (`panorama.open`) for deep, interactive dependency management with full accessibility support (roving `tabindex` table focus, global keyboard shortcuts, error queuing toast alerts, and ARIA live progress indicators).

---

## 🚀 Getting Started

1. **Fork and clone the repository**:
   ```bash
   git clone https://github.com/salvatorecorvaglia/panorama.git
   cd panorama
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

---

## 💻 Development Workflow

### 1. Watch Mode & Local Iteration

To develop Panorama locally with live compilation:

```bash
pnpm run watch
```

This starts concurrent watch processes for both the Extension Host (`esbuild`) and the React Webview UI (`vite`).

### 2. Debugging in VS Code

1. Open the project folder in VS Code.
2. Press **`F5`** (or go to the **Run & Debug** panel and select **Run Extension**).
3. A new **Extension Development Host** window will launch running your local build of Panorama.
4. Open any project or workspace with supported dependency manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle`, `build.gradle.kts`) to test functionality.

---

## 📜 Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `build` | `pnpm run build` | Builds both the extension host (`build:host`) and webview UI (`build:webview`). |
| `build:host` | `pnpm run build:host` | Compiles extension host TypeScript source into `dist/extension.js` using `esbuild`. |
| `build:webview` | `pnpm run build:webview` | Bundles webview UI application into `dist/webview` using `vite`. |
| `watch` | `pnpm run watch` | Watches for source changes and incrementally rebuilds host & webview assets. |
| `typecheck` | `pnpm run typecheck` | Runs `tsc --noEmit` across both extension host and webview TypeScript configurations. |
| `lint` | `pnpm run lint` | Runs [Biome](https://biomejs.dev) linter and formatter checks across the codebase. |
| `lint:fix` | `pnpm run lint:fix` | Runs Biome checks and automatically applies safe fixes. |
| `format` | `pnpm run format` | Formats all files using Biome. |
| `test` | `pnpm run test` | Runs unit test suite via [Vitest](https://vitest.dev). |
| `test:watch` | `pnpm run test:watch` | Runs Vitest in interactive watch mode for rapid iteration. |
| `test:coverage` | `pnpm run test:coverage` | Runs unit tests and generates code coverage reports. |
| `test:integration` | `pnpm run test:integration` | Runs VS Code extension integration tests inside an automated extension host. |
| `test:all` | `pnpm run test:all` | Executes both unit test and integration test suites. |
| `package` | `pnpm run package` | Packages the extension into a standalone `.vsix` installer file using `@vscode/vsce`. |

---

## 🧪 Testing & Verification Guidelines

Panorama includes comprehensive unit tests (`tests/unit/`), React webview component tests (`tests/webview/` using Testing Library & JSDOM), and extension host integration tests (`tests/integration/`).

Before submitting a pull request, verify that all quality and test checks pass cleanly:

```bash
# 1. Verify TypeScript types across host and webview
pnpm run typecheck

# 2. Check code style and formatting rules with Biome
pnpm run lint

# 3. Format code automatically (if needed)
pnpm run format

# 4. Run unit & webview component test suite
pnpm run test

# 5. Run integration tests (optional locally, mandatory in CI)
pnpm run test:integration
```

---

## 📦 Release & Tagging Process

Panorama uses GitHub Actions to automate release builds whenever a version tag is created and pushed:

1. **Update `package.json` version** and document release highlights in [CHANGELOG.md](CHANGELOG.md).
2. **Commit changes**:
   ```bash
   git commit -am "release: v1.x.x"
   ```
3. **Create and push tag**:
   ```bash
   git tag -a v1.x.x -m "Panorama v1.x.x"
   git push origin v1.x.x
   ```
4. The Release workflow (`.github/workflows/release.yml`) will:
   - Run typechecks, Biome linting, and Vitest test suites.
   - Package the extension into a `.vsix` installer artifact.
   - Extract the version entry from `CHANGELOG.md` for release notes.
   - Publish a new release on GitHub with the compiled `.vsix` attached.

---

## 📬 Submitting Pull Requests

1. **Create a topic branch**:
   ```bash
   git checkout -b feature/awesome-feature
   ```
2. **Commit your changes**:
   Keep commits atomic and write clear, descriptive commit messages.
3. **Push to your fork**:
   ```bash
   git push origin feature/awesome-feature
   ```
4. **Open a Pull Request**:
   - Provide a clear title and description explaining the motivation and changes made.
   - Link related issues (e.g. `Fixes #123`).
   - Ensure all CI workflow checks pass.

---

Happy coding! 🔭