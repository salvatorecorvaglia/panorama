/**
 * The Activity Bar tree: projects at the top level, dependencies underneath,
 * grouped by scope when a project has more than one.
 *
 * The tree is the always-visible companion to the panel — it answers "is
 * anything out of date?" at a glance without giving up editor space.
 */

import * as vscode from 'vscode';
import type { ScanResult } from '../core/scanner.js';
import type { Dependency, ProjectGroup } from '../core/types.js';

type Node =
  | { kind: 'project'; group: ProjectGroup }
  | { kind: 'scope'; group: ProjectGroup; scope: string }
  | { kind: 'dependency'; dep: Dependency }
  | { kind: 'empty'; message: string };

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
      muted: 0,
      stale: false,
    },
  };

  update(result: ScanResult): void {
    this.result = result;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'empty': {
        const item = new vscode.TreeItem(node.message);
        item.contextValue = 'empty';
        return item;
      }

      case 'project': {
        const outdated = node.group.dependencies.filter(
          (dep) => dep.updateKind !== 'none' && dep.updateKind !== 'unknown',
        ).length;

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
          SCOPE_LABELS[node.scope] ?? node.scope,
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
        item.command = {
          command: 'panorama.open',
          title: 'Open in Panorama',
        };
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (this.result.groups.length === 0) {
        return [
          { kind: 'empty', message: 'No manifests found in this workspace' },
        ];
      }
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
        return sortDependencies(node.group.dependencies).map((dep) => ({
          kind: 'dependency' as const,
          dep,
        }));
      }
      return scopes
        .sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b))
        .map((scope) => ({ kind: 'scope' as const, group: node.group, scope }));
    }

    if (node.kind === 'scope') {
      return sortDependencies(
        node.group.dependencies.filter((dep) => dep.scope === node.scope),
      ).map((dep) => ({ kind: 'dependency' as const, dep }));
    }

    return [];
  }
}

const SCOPE_ORDER = ['prod', 'dev', 'build', 'peer', 'optional'];

const SCOPE_LABELS: Record<string, string> = {
  prod: 'Production',
  dev: 'Development',
  build: 'Build',
  peer: 'Peer',
  optional: 'Optional',
};

/** Problems first, then outdated, then alphabetical. */
function sortDependencies(dependencies: Dependency[]): Dependency[] {
  return [...dependencies].sort((a, b) => {
    const rank = (dep: Dependency) => {
      if (dep.vulnerabilities.length > 0) return 0;
      if (dep.meta?.deprecated) return 1;
      if (dep.updateKind === 'major') return 2;
      if (dep.updateKind === 'minor' || dep.updateKind === 'patch') return 3;
      return 4;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

function describeVersion(dep: Dependency): string {
  const current = dep.installed ?? dep.declared;
  if (
    dep.updateKind === 'none' ||
    dep.updateKind === 'unknown' ||
    !dep.latest
  ) {
    return current;
  }
  return `${current} → ${dep.latest}`;
}

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
  if (dep.meta?.license) lines.push(`- License: ${dep.meta.license}`);

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
