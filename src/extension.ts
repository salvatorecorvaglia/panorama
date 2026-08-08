/**
 * Extension entry point: builds the object graph and registers commands.
 *
 * Everything here is wiring — the behaviour lives in `core/`, `providers/` and
 * `ui/`. Activation stays cheap because the first scan is scheduled rather than
 * awaited, so opening a project never blocks on the network.
 */

import * as vscode from 'vscode';
import { TtlCache } from './core/cache.js';
import { HttpClient } from './core/http.js';
import { MuteList } from './core/muteList.js';
import { Scanner, type ScanResult } from './core/scanner.js';
import { ScanQueue } from './core/scanQueue.js';
import type { Dependency } from './core/types.js';
import { ManifestWatcher } from './core/watcher.js';
import { createProviderContext } from './core/workspace.js';
import { PanelManager } from './ui/panelManager.js';
import { DependencyTreeProvider } from './ui/treeProvider.js';

/**
 * The object `activate` returns.
 *
 * Deliberately tiny and read-only: it exists so integration tests can assert on
 * a real scan rather than scraping the UI, and is not a public extension API.
 */
export interface PanoramaApi {
  /** Runs a scan. Pass `checkUpdates: false` to stay entirely offline. */
  scan(options?: {
    checkUpdates?: boolean;
    audit?: boolean;
  }): Promise<ScanResult>;
  /** The most recent result, without triggering new work. */
  getResult(): ScanResult;
  muteList: MuteList;
  /**
   * Total network requests issued since activation.
   *
   * Lets the integration suite assert the offline guarantee directly rather
   * than inferring it from how long a refresh took.
   */
  requestCount(): number;
}

/**
 * Shown by every command that needs a package and cannot find one. Identical
 * wording and identical consequences — none of them reveal an unrelated panel
 * as a side effect of failing.
 */
const NO_SELECTION_MESSAGE =
  'Select a package in the Panorama panel or sidebar first.';

export function activate(context: vscode.ExtensionContext): PanoramaApi {
  const version =
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  const config = () => vscode.workspace.getConfiguration('panorama');

  /**
   * Under the integration test host every scan stays offline.
   *
   * Registry results change daily and CI may have no egress at all, so a suite
   * that reached the network would be both slow and flaky. Tests that genuinely
   * want a lookup can still opt in through `PanoramaApi.scan`.
   */
  const isTestHost = context.extensionMode === vscode.ExtensionMode.Test;

  /** Whether an automatic or command-driven scan may contact registries. */
  const networkAllowed = (requested = true): boolean =>
    !isTestHost && requested && config().get<boolean>('autoCheckUpdates', true);

  const http = new HttpClient(version, config().get<string>('contactEmail'));
  const cache = new TtlCache(context.globalState);
  // Lapsed entries would otherwise accumulate in globalState forever, and
  // globalState is loaded synchronously on every extension-host start. Not
  // awaited: nothing below depends on it, and activation stays cheap.
  void cache.prune();
  const providerContext = createProviderContext(http, cache);
  // Muting is a per-project decision, so it lives in workspaceState rather than
  // leaking across every project the user opens.
  const muteList = new MuteList(context.workspaceState);
  const scanner = new Scanner(providerContext, muteList);

  const tree = new DependencyTreeProvider();
  const treeView = vscode.window.createTreeView('panorama.explorer', {
    treeDataProvider: tree,
  });

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = 'panorama.open';

  const panel = new PanelManager(
    context.extensionUri,
    scanner,
    providerContext,
    (result) => {
      tree.update(result);
      updateStatusBar(statusBar, result);
      treeView.badge =
        result.summary.outdated > 0
          ? {
              value: result.summary.outdated,
              tooltip: `${result.summary.outdated} outdated`,
            }
          : undefined;
    },
    muteList,
  );

  /** The single path through which every refresh flows. */
  const scans = new ScanQueue<ScanResult | undefined>((request) =>
    doScan(request.checkUpdates, request.audit),
  );

  const runScan = (
    checkUpdates: boolean,
    audit?: boolean,
  ): Promise<ScanResult | undefined> => scans.request({ checkUpdates, audit });

  const doScan = async (
    checkUpdates: boolean,
    audit?: boolean,
  ): Promise<ScanResult | undefined> => {
    panel.setBusy(
      true,
      checkUpdates ? 'Checking registries…' : 'Reading manifests…',
    );

    try {
      const result = await scanner.scan(
        {
          checkUpdates,
          audit: audit ?? config().get<boolean>('enableAudit', true),
        },
        // Paint manifest data immediately; registry data lands a moment later.
        (partial) => panel.setResult(partial),
      );
      panel.setResult(result);

      if (result.summary.stale) {
        vscode.window.setStatusBarMessage(
          '$(cloud-offline) Panorama: showing cached data — registries unreachable',
          5000,
        );
      }
      if (scanner.hitManifestLimit) {
        vscode.window.setStatusBarMessage(
          `$(warning) Panorama: stopped at ${Scanner.manifestLimit} manifests — add patterns to panorama.excludeGlobs`,
          8000,
        );
      }
      return result;
    } catch (error) {
      if (!isAbort(error)) {
        void vscode.window.showErrorMessage(
          `Panorama scan failed: ${describe(error)}`,
        );
      }
      return undefined;
    } finally {
      panel.setBusy(false);
    }
  };

  const watcher = new ManifestWatcher(() => {
    void runScan(networkAllowed());
  });

  context.subscriptions.push(
    treeView,
    statusBar,
    panel,
    watcher,

    vscode.commands.registerCommand('panorama.open', () => {
      panel.reveal();
      if (panel.currentResult.groups.length === 0) {
        void runScan(networkAllowed());
      }
    }),

    vscode.commands.registerCommand('panorama.refresh', () =>
      runScan(networkAllowed()),
    ),

    // Explicit user intent, so this ignores autoCheckUpdates — but still stays
    // offline under the test host.
    vscode.commands.registerCommand('panorama.checkUpdates', () =>
      runScan(!isTestHost),
    ),

    vscode.commands.registerCommand('panorama.searchInstall', () => {
      panel.revealSearch();
    }),

    // Fired by clicking a package in the tree, so the panel opens focused on
    // that package instead of merely opening.
    vscode.commands.registerCommand(
      'panorama.revealDependency',
      (item?: unknown) => {
        const dep = dependencyFromTreeItem(item);
        if (!dep) {
          panel.reveal();
          return;
        }
        panel.revealDependency(dep.key, 'details');
      },
    ),

    vscode.commands.registerCommand(
      'panorama.toggleMute',
      async (item?: unknown) => {
        const dep =
          dependencyFromTreeItem(item) ??
          findByKey(panel.currentResult, panel.lastSelectedKey);
        if (!dep) {
          void vscode.window.showInformationMessage(NO_SELECTION_MESSAGE);
          return;
        }
        const nowMuted = await muteList.toggle(dep);
        panel.setResult(
          scanner.resummarize(
            panel.currentResult.groups,
            panel.currentResult.summary.stale,
          ),
        );
        void vscode.window.showInformationMessage(
          nowMuted ? `Muted updates for ${dep.name}.` : `Unmuted ${dep.name}.`,
        );
      },
    ),

    vscode.commands.registerCommand('panorama.clearMuted', async () => {
      if (muteList.size === 0) {
        void vscode.window.showInformationMessage(
          'No muted packages in this workspace.',
        );
        return;
      }
      const count = muteList.size;
      await muteList.clear();
      panel.setResult(
        scanner.resummarize(
          panel.currentResult.groups,
          panel.currentResult.summary.stale,
        ),
      );
      void vscode.window.showInformationMessage(`Unmuted ${count} package(s).`);
    }),

    vscode.commands.registerCommand('panorama.updateAll', async () => {
      const groups = panel.currentResult.groups;
      if (groups.length === 0) {
        void vscode.window.showInformationMessage(
          'Panorama has not found any manifests yet.',
        );
        return;
      }
      // With one project there is nothing to disambiguate.
      const target = groups.length === 1 ? groups[0] : await pickGroup(groups);
      if (!target) return;
      panel.reveal();
      await panel.updateAll(target.manifestPath);
    }),

    // Invoked from the tree view's inline action (which passes the item) or
    // from the command palette (which does not, so we fall back to selection).
    vscode.commands.registerCommand('panorama.showWhy', (item?: unknown) => {
      const dep =
        dependencyFromTreeItem(item) ??
        findByKey(panel.currentResult, panel.lastSelectedKey);
      if (!dep) {
        void vscode.window.showInformationMessage(NO_SELECTION_MESSAGE);
        return;
      }
      panel.revealDependency(dep.key, 'why');
    }),

    // Rebuilding the User-Agent keeps the contact address in sync with settings.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('panorama.contactEmail')) {
        http.setContactEmail(version, config().get<string>('contactEmail'));
      }
      if (
        event.affectsConfiguration('panorama.excludeGlobs') ||
        event.affectsConfiguration('panorama.preferredNodeManager') ||
        event.affectsConfiguration('panorama.pythonManager')
      ) {
        void runScan(false);
      }
      // Re-arm rather than wait for a window reload — a setting that only takes
      // effect after a restart reads as a setting that does not work.
      if (event.affectsConfiguration('panorama.checkIntervalMinutes')) {
        armPeriodicCheck();
      }
    }),
  );

  // Periodic background re-check, when enabled. Never armed under the test
  // host, where a timer firing mid-suite would be a source of flakiness.
  let periodicTimer: NodeJS.Timeout | undefined;

  const armPeriodicCheck = (): void => {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = undefined;
    }
    if (isTestHost) return;

    const intervalMinutes = config().get<number>('checkIntervalMinutes', 60);
    if (intervalMinutes <= 0) return;

    periodicTimer = setInterval(
      () => {
        if (networkAllowed()) {
          void runScan(true);
        }
      },
      intervalMinutes * 60 * 1000,
    );
  };

  armPeriodicCheck();
  context.subscriptions.push({
    dispose: () => {
      if (periodicTimer) clearInterval(periodicTimer);
    },
  });

  // Kick off the first scan without blocking activation.
  void runScan(networkAllowed());

  return {
    scan: async (options) => {
      // Let any in-flight scan settle first, so a caller never observes the
      // empty state that precedes the activation scan.
      await scans.settled();
      const result = await runScan(
        options?.checkUpdates ?? false,
        options?.audit ?? false,
      );
      return result ?? panel.currentResult;
    },
    getResult: () => panel.currentResult,
    muteList,
    requestCount: () => http.requestCount,
  };
}

export function deactivate(): void {
  // All resources are registered in context.subscriptions and disposed by VS Code.
}

async function pickGroup(groups: ScanResult['groups']) {
  const picked = await vscode.window.showQuickPick(
    groups.map((group) => ({
      label: group.label,
      description: group.toolchain,
      group,
    })),
    { title: 'Which project do you want to update?' },
  );
  return picked?.group;
}

function updateStatusBar(item: vscode.StatusBarItem, result: ScanResult): void {
  const { totalDependencies, outdated, vulnerable } = result.summary;

  if (totalDependencies === 0) {
    item.hide();
    return;
  }

  const parts: string[] = [];
  if (vulnerable > 0) parts.push(`$(shield) ${vulnerable}`);
  if (outdated > 0) parts.push(`$(arrow-up) ${outdated}`);

  item.text =
    parts.length > 0
      ? `$(package) ${parts.join(' ')}`
      : `$(package) ${totalDependencies}`;
  item.tooltip = `Panorama — ${totalDependencies} dependencies, ${outdated} outdated, ${vulnerable} vulnerable`;
  item.backgroundColor =
    vulnerable > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  item.show();
}

/**
 * Tree view commands receive the node that was clicked. Only dependency nodes
 * carry one, so anything else resolves to undefined and the caller falls back.
 */
function dependencyFromTreeItem(item: unknown): Dependency | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const node = item as { kind?: unknown; dep?: unknown };
  if (node.kind !== 'dependency' || !node.dep) return undefined;
  return node.dep as Dependency;
}

function findByKey(
  result: ScanResult,
  key: string | undefined,
): Dependency | undefined {
  if (!key) return undefined;
  for (const group of result.groups) {
    const dep = group.dependencies.find((candidate) => candidate.key === key);
    if (dep) return dep;
  }
  return undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
