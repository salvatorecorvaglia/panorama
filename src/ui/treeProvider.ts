/**
 * The Activity Bar tree: projects at the top level, dependencies underneath,
 * grouped by scope when a project has more than one.
 *
 * The tree is the always-visible companion to the panel — it answers "is
 * anything out of date?" at a glance without giving up editor space. Labels,
 * ordering and severity colours all come from `core/vocabulary.ts` and the
 * severity map below, so the tree and the panel can never drift into
 * describing the same package two different ways.
 */

import * as vscode from 'vscode';
import type { ScanResult } from '../core/scanner.js';
import type { Dependency, ProjectGroup } from '../core/types.js';
import {
  currentVersion,
  hasUpdate,
  SCOPE_LABELS,
  sortByStatus,
} from '../core/vocabulary.js';

export type Node =
  | { kind: 'project'; group: ProjectGroup }
  | { kind: 'scope'; group: ProjectGroup; scope: string }
  | { kind: 'dependency'; dep: Dependency };

export class DependencyTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private result: ScanResult = {
    groups: [],
    summary: {
      totalDependencies: 0,
      outdated: 0,
      vulnerable: 0,
      deprecated: 0,
      stale: false,
    },
  };

  update(result: ScanResult): void {
    this.result = result;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'project': {
        const outdated = node.group.dependencies.filter(hasUpdate).length;

        const item = new vscode.TreeItem(
          node.group.label,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description =
          outdated > 0
            ? `${node.group.toolchain} · ${outdated} outdated`
            : node.group.toolchain;
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.contextValue = 'project';
        item.resourceUri = vscode.Uri.file(node.group.manifestPath);
        return item;
      }

      case 'scope': {
        const item = new vscode.TreeItem(
          SCOPE_LABELS[node.scope as keyof typeof SCOPE_LABELS]?.long ??
            node.scope,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'scope';
        return item;
      }

      case 'dependency': {
        const dep = node.dep;
        const item = new vscode.TreeItem(
          dep.name,
          vscode.TreeItemCollapsibleState.None,
        );

        item.description = describeVersion(dep);
        item.iconPath = iconFor(dep);
        item.contextValue = 'dependency';
        item.tooltip = buildTooltip(dep);
        // Passing the node is what lets the panel open *on this package*
        // rather than merely opening.
        item.command = {
          command: 'panorama.revealDependency',
          title: 'Open in Panorama',
          arguments: [node],
        };
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.result.groups.map((group) => ({
        kind: 'project' as const,
        group,
      }));
    }

    if (node.kind === 'project') {
      const scopes = [
        ...new Set(node.group.dependencies.map((dep) => dep.scope)),
      ];
      // Skip the scope level entirely when there is only one — an extra click
      // for no information.
      if (scopes.length <= 1) {
        return sortByStatus(node.group.dependencies).map((dep) => ({
          kind: 'dependency' as const,
          dep,
        }));
      }
      return scopes
        .sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b))
        .map((scope) => ({ kind: 'scope' as const, group: node.group, scope }));
    }

    if (node.kind === 'scope') {
      return sortByStatus(
        node.group.dependencies.filter((dep) => dep.scope === node.scope),
      ).map((dep) => ({ kind: 'dependency' as const, dep }));
    }

    return [];
  }
}

const SCOPE_ORDER = Object.keys(SCOPE_LABELS);

function describeVersion(dep: Dependency): string {
  const current = currentVersion(dep);
  return hasUpdate(dep) && dep.latest ? `${current} → ${dep.latest}` : current;
}

/**
 * The tree half of the severity map declared in `theme.css`. Red means
 * "vulnerable" and nothing else; a major update is orange in both surfaces.
 */
function iconFor(dep: Dependency): vscode.ThemeIcon {
  if (dep.vulnerabilities.length > 0) {
    return new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.red'));
  }
  if (dep.meta?.deprecated) {
    return new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('charts.yellow'),
    );
  }
  switch (dep.updateKind) {
    case 'major':
      return new vscode.ThemeIcon(
        'arrow-up',
        new vscode.ThemeColor('charts.orange'),
      );
    case 'minor':
      return new vscode.ThemeIcon(
        'arrow-up',
        new vscode.ThemeColor('charts.yellow'),
      );
    case 'patch':
      return new vscode.ThemeIcon(
        'arrow-up',
        new vscode.ThemeColor('charts.blue'),
      );
    default:
      return new vscode.ThemeIcon('package');
  }
}

function buildTooltip(dep: Dependency): vscode.MarkdownString {
  const lines: string[] = [`**${dep.name}**`, ''];

  lines.push(`- Declared: \`${dep.declared}\``);
  if (dep.installed) lines.push(`- Installed: \`${dep.installed}\``);
  if (dep.latest) lines.push(`- Latest: \`${dep.latest}\``);

  if (dep.meta?.deprecated) {
    lines.push('', `⚠️ **Deprecated** — ${dep.meta.deprecated}`);
  }

  if (dep.vulnerabilities.length > 0) {
    lines.push(
      '',
      `🛡️ **${dep.vulnerabilities.length} known vulnerability(ies)**`,
    );
    for (const vuln of dep.vulnerabilities.slice(0, 3)) {
      lines.push(`- ${vuln.severity.toUpperCase()}: ${vuln.summary}`);
    }
  }

  const markdown = new vscode.MarkdownString(lines.join('\n'));
  markdown.supportThemeIcons = true;
  return markdown;
}
