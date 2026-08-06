# Contributing to Panorama 🔭

Thank you for your interest in contributing to **Panorama**! We welcome contributions, bug reports, feature requests, and security improvements from the community.

---

## 🛠️ Prerequisites

Before you start, ensure you have the following installed on your system:

- **Node.js**: `v22.13.0` or higher
- **pnpm**: `v11.17.0` or higher (managed via `packageManager` in `package.json`)
- **VS Code**: `v1.90.0` or higher

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

This runs concurrent watch processes for both the Extension Host (`esbuild`) and the React Webview (`vite`).

### 2. Debugging in VS Code

1. Open the project folder in VS Code.
2. Press **`F5`** (or go to the **Run & Debug** panel and select **Run Extension**).
3. A new **Extension Development Host** window will open with your local build of Panorama running.
4. Open any workspace with manifest files (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.) to test Panorama features.

---

## 📜 Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `build` | `pnpm run build` | Builds both the extension host (`build:host`) and webview UI (`build:webview`). |
| `watch` | `pnpm run watch` | Watches for source changes and rebuilds host & webview incrementally. |
| `typecheck` | `pnpm run typecheck` | Runs `tsc --noEmit` across both extension host and webview TypeScript configurations. |
| `lint` | `pnpm run lint` | Runs [Biome](https://biomejs.dev) linter and formatter checks across the codebase. |
| `lint:fix` | `pnpm run lint:fix` | Runs Biome checks and automatically applies safe fixes. |
| `format` | `pnpm run format` | Formats all files using Biome. |
| `test` | `pnpm run test` | Runs fast unit tests via [Vitest](https://vitest.dev). |
| `test:watch` | `pnpm run test:watch` | Runs Vitest in interactive watch mode. |
| `test:integration` | `pnpm run test:integration` | Runs VS Code extension integration tests inside an automated extension host. |
| `test:all` | `pnpm run test:all` | Executes both unit test and integration test suites. |
| `package` | `pnpm run package` | Packages the extension into a `.vsix` file using `@vscode/vsce`. |

---

## 🧪 Testing & Verification Guidelines

Before opening a pull request, ensure all verification checks pass cleanly:

```bash
# 1. Verify TypeScript types
pnpm run typecheck

# 2. Check code style and formatting with Biome
pnpm run lint

# 3. Format code automatically (if needed)
pnpm run format

# 4. Run unit tests
pnpm run test

# 5. Run integration tests (optional locally, required on CI)
pnpm run test:integration
```

---

## 📬 Submitting Pull Requests

1. **Create a topic branch**:
   ```bash
   git checkout -b feature/awesome-feature
   ```
2. **Commit your changes**:
   Keep commits focused and write concise commit messages.
3. **Push to your fork**:
   ```bash
   git push origin feature/awesome-feature
   ```
4. **Open a Pull Request**:
   - Provide a clear title and description explaining the motivation and changes made.
   - Reference any related issues (e.g. `Fixes #123`).
   - Ensure all CI tests pass.

---

Happy coding! 🔭