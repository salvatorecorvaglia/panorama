/**
 * Owns the webview panel: its lifecycle, its HTML shell, and the message router
 * connecting the React app to the scanner, providers and terminal.
 *
 * Security posture: the webview loads only local scripts under a per-load nonce
 * and is given no network access at all (`connect-src 'none'`). Every registry
 * call happens in the extension host, which is also the only place that can
 * reach the filesystem or spawn a terminal.
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { explainDependency } from '../core/depGraph.js';
import { findDeclaration } from '../core/findDeclaration.js';
import type { MuteList } from '../core/muteList.js';
import type { HostMessage, WebviewMessage } from '../core/protocol.js';
import type { Scanner, ScanResult } from '../core/scanner.js';
import type {
  Dependency,
  DepScope,
  Ecosystem,
  ProjectGroup,
} from '../core/types.js';
import { hasUpdate } from '../core/vocabulary.js';
import type { ProviderContext } from '../providers/provider.js';
import { validateVersion } from '../providers/provider.js';
import { providerFor, providerForPath } from '../providers/registry.js';
import { TerminalRunner } from './terminalRunner.js';

export class PanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private latest: ScanResult = {
    groups: [],
    summary: {
      totalDependencies: 0,
      outdated: 0,
      vulnerable: 0,
      deprecated: 0,
      muted: 0,
      stale: false,
    },
  };
  private readonly searches = new Map<string, AbortController>();
  /** The in-flight "why is this installed" resolution, if any. */
  private whyRequest: AbortController | undefined;
  private readonly terminal = new TerminalRunner();
  private busy = false;
  /** False between creating a panel and the React app announcing itself. */
  private webviewReady = false;
  /**
   * A reveal requested before the webview finished loading.
   *
   * Opening the panel and telling it what to show happen in the same tick, but
   * a message posted to a webview that has not loaded yet is simply dropped —
   * which is how "click a package in the tree" used to open the panel on
   * nothing in particular.
   */
  private pendingReveal: HostMessage | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scanner: Scanner,
    private readonly ctx: ProviderContext,
    private readonly onStateChanged: (result: ScanResult) => void,
    private readonly muteList?: MuteList,
  ) {}

  get currentResult(): ScanResult {
    return this.latest;
  }

  /** Opens the panel, or reveals it if already open. */
  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'panorama.dependencies',
      'Panorama: Dependencies',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The table keeps sort/filter state, so rebuilding it on every tab
        // switch would be user-hostile.
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        ],
      },
    );

    this.panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'resources',
      'panorama.svg',
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.webviewReady = false;
      this.pendingReveal = undefined;
      for (const controller of this.searches.values()) {
        controller.abort();
      }
      this.searches.clear();
    });

    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
  }

  /** Pushes a new scan result to the webview and the tree view. */
  setResult(result: ScanResult): void {
    this.latest = result;
    this.post({
      type: 'state',
      groups: result.groups,
      summary: result.summary,
    });
    this.onStateChanged(result);
  }

  setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.post({ type: 'scanning', busy, label });
  }

  /** Opens the panel with the registry search UI focused. */
  revealSearch(): void {
    this.reveal();
    this.postOrQueue({ type: 'focusSearch' });
  }

  /**
   * Opens the panel with a specific package selected. Used by the tree view's
   * "Why Is This Installed?" action, and by the command palette when a row is
   * already selected.
   */
  revealDependency(depKey: string, section: 'details' | 'why'): void {
    this.reveal();
    this.postOrQueue({ type: 'focusDependency', depKey, reveal: section });
  }

  /** The row most recently opened in the drawer, for command-palette actions. */
  get lastSelectedKey(): string | undefined {
    return this.selectedKey;
  }

  private selectedKey: string | undefined;

  private async toggleMute(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found || !this.muteList) return;

    const nowMuted = await this.muteList.toggle(found.dep);
    // Recomputing the summary keeps the badge honest without a network round-trip.
    this.setResult(
      this.scanner.resummarize(this.latest.groups, this.latest.summary.stale),
    );
    this.post({
      type: 'notice',
      message: nowMuted
        ? `Muted updates for ${found.dep.name}. It stays listed but no longer counts as outdated.`
        : `Unmuted ${found.dep.name}.`,
    });
  }

  private post(message: HostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Sends now if the webview can hear it, otherwise on its `ready`. */
  private postOrQueue(message: HostMessage): void {
    if (this.webviewReady) {
      this.post(message);
      return;
    }
    this.pendingReveal = message;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        this.webviewReady = true;
        this.post({
          type: 'state',
          groups: this.latest.groups,
          summary: this.latest.summary,
        });
        this.post({ type: 'scanning', busy: this.busy });
        // Anything asked for while the panel was still loading, replayed now
        // that there is something listening — and after `state`, so the row it
        // names already exists.
        if (this.pendingReveal) {
          this.post(this.pendingReveal);
          this.pendingReveal = undefined;
        }
        return;
      }

      case 'refresh':
        await vscode.commands.executeCommand('panorama.refresh');
        return;

      case 'checkUpdates':
        await vscode.commands.executeCommand('panorama.checkUpdates');
        return;

      case 'search':
        await this.handleSearch(
          message.query,
          message.ecosystem,
          message.requestId,
        );
        return;

      case 'cancelSearch': {
        this.searches.get(message.requestId)?.abort();
        this.searches.delete(message.requestId);
        return;
      }

      case 'install':
        await this.handleInstall(
          message.name,
          message.version,
          message.scope,
          message.manifestPath,
        );
        return;

      case 'update':
        await this.handleUpdate(message.depKey, message.toVersion);
        return;

      case 'updateAll':
        await this.updateAll(message.manifestPath);
        return;

      case 'uninstall':
        await this.handleUninstall(message.depKey);
        return;

      case 'requestDetails':
        await this.handleDetails(message.depKey);
        return;

      case 'requestWhy':
        await this.handleWhy(message.depKey);
        return;

      case 'toggleMute':
        await this.toggleMute(message.depKey);
        return;

      case 'openExternal':
        await this.openExternal(message.url);
        return;

      case 'openManifest':
        await this.openManifest(message.manifestPath, message.packageName);
        return;
    }
  }

  private async handleSearch(
    query: string,
    ecosystem: Ecosystem | 'all',
    requestId: string,
  ): Promise<void> {
    // Supersede any in-flight search — the user has typed since.
    for (const [id, controller] of this.searches) {
      controller.abort();
      this.searches.delete(id);
    }

    const controller = new AbortController();
    this.searches.set(requestId, controller);

    try {
      const { results, failed } = await this.scanner.search(
        query,
        ecosystem,
        controller.signal,
      );

      // Annotate anything already present in a loaded manifest so the UI can
      // offer "uninstall" instead of "install".
      for (const result of results) {
        const matches: NonNullable<(typeof results)[number]['installedIn']> =
          [];
        for (const group of this.latest.groups) {
          for (const dep of group.dependencies) {
            if (
              dep.ecosystem === result.ecosystem &&
              dep.name === result.name
            ) {
              matches.push({
                manifestPath: group.manifestPath,
                projectLabel: group.label,
                declared: dep.declared,
                scope: dep.scope,
              });
            }
          }
        }
        if (matches.length > 0) {
          result.installedIn = matches;
        }
      }

      if (!controller.signal.aborted) {
        // Nothing came back and nothing succeeded: that is a failure, not an
        // empty result set, and saying "no packages found" would be a lie.
        if (results.length === 0 && failed.length > 0) {
          this.post({
            type: 'searchError',
            requestId,
            message: `Could not reach ${failed.map(registryName).join(', ')}. Check your connection and try again.`,
          });
          return;
        }
        this.post({ type: 'searchResults', requestId, results, failed });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.post({
          type: 'searchError',
          requestId,
          message: describeError(error),
        });
      }
    } finally {
      this.searches.delete(requestId);
    }
  }

  private async handleInstall(
    name: string,
    version: string | null,
    scope: DepScope,
    manifestPath: string,
  ): Promise<void> {
    const provider = providerForPath(manifestPath);
    if (!provider) {
      this.post({
        type: 'error',
        message: `No provider handles ${path.basename(manifestPath)}`,
      });
      return;
    }

    if (!provider.isValidPackageName(name)) {
      this.post({
        type: 'error',
        message: `"${name}" is not a valid package name.`,
      });
      return;
    }

    // A version is no more trusted than a name: both arrive from the webview,
    // and both end up on a command line.
    if (version !== null && !validateVersion(provider, version)) {
      this.post({
        type: 'error',
        message: `"${version}" is not a valid version.`,
      });
      return;
    }

    const toolchain = await provider.detectToolchain(manifestPath, this.ctx);
    const command = provider.installCommand(toolchain, name, version, scope);
    const edit = { kind: 'add' as const, name, version, scope };

    if (command) {
      await this.runCommand(command.argv, command.cwd, command.description);
      // pip installs into the environment without recording anything, so the
      // manifest edit is what makes the install outlive the next reinstall.
      if (command.writesManifest === false) {
        await this.applyManifestEdit(provider, manifestPath, edit);
      }
      return;
    }

    // No CLI for this edit — fall back to a manifest edit where the provider
    // supports one (requirements.txt, pom.xml).
    const applied = await this.applyManifestEdit(provider, manifestPath, edit);

    if (!applied) {
      this.post({
        type: 'error',
        message:
          `Panorama cannot add ${name} to ${path.basename(manifestPath)} automatically. ` +
          `Opening the file so you can add it by hand.`,
      });
      await this.openManifest(manifestPath);
    }
  }

  private async handleUpdate(depKey: string, toVersion: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;
    const { dep } = found;

    if (!validateVersion(providerFor(dep.ecosystem), toVersion)) {
      this.post({
        type: 'error',
        message: `"${toVersion}" is not a valid version.`,
      });
      return;
    }

    // Bulk updates already ask before crossing a major boundary; a single one
    // is no less likely to break the build, so it asks too.
    if (dep.updateKind === 'major') {
      const choice = await vscode.window.showWarningMessage(
        `Update ${dep.name} to ${toVersion}?`,
        {
          modal: true,
          detail: `This is a major upgrade from ${dep.installed ?? dep.declared} and may contain breaking changes.`,
        },
        'Update',
      );
      if (choice !== 'Update') return;
    }

    const provider = providerFor(dep.ecosystem);
    const toolchain = await provider.detectToolchain(
      dep.manifestPath,
      this.ctx,
    );
    const command = provider.updateCommand(toolchain, dep, toVersion);
    const edit = {
      kind: 'update' as const,
      name: dep.name,
      version: toVersion,
      scope: dep.scope,
    };

    if (command) {
      await this.runCommand(command.argv, command.cwd, command.description);
      if (command.writesManifest === false) {
        await this.applyManifestEdit(provider, dep.manifestPath, edit);
      }
      return;
    }

    const applied = await this.applyManifestEdit(
      provider,
      dep.manifestPath,
      edit,
    );

    if (!applied) {
      this.post({
        type: 'error',
        message:
          `${dep.name} is declared in a form Panorama cannot rewrite safely ` +
          `(a computed or inherited version). Opening the file instead.`,
      });
      await this.openManifest(dep.manifestPath, dep.name);
    }
  }

  /** Also invoked from the `panorama.updateAll` command, not just the webview. */
  async updateAll(manifestPath: string): Promise<void> {
    const group = this.latest.groups.find(
      (candidate) => candidate.manifestPath === manifestPath,
    );
    if (!group) return;

    const outdated = group.dependencies.filter(hasUpdate);
    if (outdated.length === 0) {
      this.post({
        type: 'notice',
        message: 'Everything is already up to date.',
      });
      return;
    }

    const majors = outdated.filter((dep) => dep.updateKind === 'major');
    const detail =
      majors.length > 0
        ? `${outdated.length} package(s), including ${majors.length} major upgrade(s) that may contain breaking changes.`
        : `${outdated.length} package(s), all minor or patch.`;

    const choice = await vscode.window.showWarningMessage(
      `Update all dependencies in ${group.label}?`,
      { modal: true, detail },
      'Update',
    );
    if (choice !== 'Update') return;

    const provider = providerFor(group.ecosystem);
    const toolchain = await provider.detectToolchain(manifestPath, this.ctx);
    const command = provider.updateAllCommand(toolchain);

    if (!command) {
      this.post({
        type: 'error',
        message: `No bulk update command for ${group.ecosystem}.`,
      });
      return;
    }

    await this.runCommand(command.argv, command.cwd, command.description);
  }

  private async handleUninstall(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;
    const { dep } = found;

    const choice = await vscode.window.showWarningMessage(
      `Remove ${dep.name} from ${path.basename(dep.manifestPath)}?`,
      { modal: true },
      'Remove',
    );
    if (choice !== 'Remove') return;

    const provider = providerFor(dep.ecosystem);
    const toolchain = await provider.detectToolchain(
      dep.manifestPath,
      this.ctx,
    );
    const command = provider.uninstallCommand(toolchain, dep);
    const edit = {
      kind: 'remove' as const,
      name: dep.name,
      scope: dep.scope,
    };

    if (command) {
      await this.runCommand(command.argv, command.cwd, command.description);
      if (command.writesManifest === false) {
        await this.applyManifestEdit(provider, dep.manifestPath, edit);
      }
      return;
    }

    const applied = await this.applyManifestEdit(
      provider,
      dep.manifestPath,
      edit,
    );

    if (!applied) {
      this.post({
        type: 'error',
        message: `Panorama could not remove ${dep.name} automatically. Opening the manifest.`,
      });
      await this.openManifest(dep.manifestPath, dep.name);
    }
  }

  private async handleDetails(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;

    // The webview requests details whenever a row opens, which makes this the
    // host's view of "what is selected" for command-palette actions.
    this.selectedKey = depKey;

    try {
      const meta = await this.scanner.fetchDetails(found.dep);
      if (meta) {
        // Preserve any deprecation notice the version lookup already found.
        found.dep.meta = {
          ...meta,
          deprecated: meta.deprecated ?? found.dep.meta?.deprecated,
        };
        // Deliberately not a full `state` push: replacing the whole list would
        // re-sort it, and a row that gains a size while the table is sorted by
        // Size would move out from under the user who just clicked it.
        this.post({ type: 'depDetails', depKey, meta: found.dep.meta });
      }
    } catch (error) {
      this.post({ type: 'error', message: describeError(error) });
    }
  }

  private async handleWhy(depKey: string): Promise<void> {
    const found = this.findDependency(depKey);
    if (!found) return;

    // Clicking through rows quickly would otherwise leave every earlier
    // resolution running, and the registry fallback is the slowest call in the
    // extension.
    this.whyRequest?.abort();
    const controller = new AbortController();
    this.whyRequest = controller;

    try {
      const result = await explainDependency(
        found.dep,
        this.ctx,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      this.post({
        type: 'whyTree',
        depKey,
        roots: result.roots,
        source: result.source,
      });
    } catch (error) {
      // A superseded request is the expected outcome of clicking the next row,
      // not something to put in front of the user.
      if (controller.signal.aborted) return;
      this.post({ type: 'error', message: describeError(error) });
    }
  }

  /** Runs a command and refreshes once it completes. */
  private async runCommand(
    argv: string[],
    cwd: string,
    description: string,
  ): Promise<void> {
    this.setBusy(true, description);
    try {
      await this.terminal.run({ argv, cwd, description });
    } finally {
      this.setBusy(false);
    }
    // The watcher usually fires first; this makes the refresh deterministic
    // even on filesystems where watch events are unreliable.
    await vscode.commands.executeCommand('panorama.refresh');
  }

  /**
   * Applies a provider's manifest edit as a WorkspaceEdit, so it lands in the
   * undo stack and respects any unsaved buffer the user has open.
   */
  private async applyManifestEdit(
    provider: ReturnType<typeof providerFor>,
    manifestPath: string,
    edit: Parameters<NonNullable<typeof provider.editManifest>>[1],
  ): Promise<boolean> {
    if (!provider.editManifest) return false;

    const uri = vscode.Uri.file(manifestPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const updated = provider.editManifest(document.getText(), edit);
    if (updated === null) return false;

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      updated,
    );
    const ok = await vscode.workspace.applyEdit(workspaceEdit);
    if (!ok) return false;

    await document.save();
    await vscode.commands.executeCommand('panorama.refresh');
    return true;
  }

  private findDependency(
    depKey: string,
  ): { group: ProjectGroup; dep: Dependency } | undefined {
    for (const group of this.latest.groups) {
      const dep = group.dependencies.find(
        (candidate) => candidate.key === depKey,
      );
      if (dep) return { group, dep };
    }
    return undefined;
  }

  /** Only ever opens http(s) links, so a malformed registry field is inert. */
  private async openExternal(url: string): Promise<void> {
    try {
      const parsed = vscode.Uri.parse(url, true);
      if (parsed.scheme !== 'https' && parsed.scheme !== 'http') {
        return;
      }
      await vscode.env.openExternal(parsed);
    } catch {
      // An unparseable URL is simply ignored.
    }
  }

  private async openManifest(
    manifestPath: string,
    packageName?: string,
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(manifestPath),
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
    });

    if (!packageName) return;

    const index = findDeclaration(document.getText(), packageName);
    if (index >= 0) {
      const position = document.positionAt(index);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'index.css'),
    );
    const nonce = createNonce();

    // connect-src 'none' is deliberate: the webview never talks to the network.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `connect-src 'none'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Panorama</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    this.terminal.dispose();
    this.panel?.dispose();
  }
}

/**
 * A CSP nonce has to be unguessable to be worth anything, so it comes from the
 * CSPRNG rather than `Math.random`. Base64url keeps it valid inside the
 * `script-src 'nonce-...'` directive without escaping.
 */
function createNonce(): string {
  return randomBytes(24).toString('base64url');
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The name users know a registry by, which is rarely our ecosystem id. */
function registryName(ecosystem: Ecosystem): string {
  const names: Record<Ecosystem, string> = {
    node: 'npm',
    python: 'PyPI',
    cargo: 'crates.io',
    golang: 'the Go module proxy',
    composer: 'Packagist',
    maven: 'Maven Central',
    gradle: 'Maven Central',
  };
  return names[ecosystem];
}
