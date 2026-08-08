/**
 * Watches manifests and lockfiles, debounced.
 *
 * Lockfiles matter as much as manifests here: watching them is what makes the
 * panel refresh itself after an install finishes, whether Panorama started it
 * or the user typed the command themselves.
 */

import * as vscode from 'vscode';
import { allWatchedFileNames } from '../providers/registry.js';

const DEBOUNCE_MS = 300;

export class ManifestWatcher implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onChange: () => void) {
    const names = allWatchedFileNames();
    // A single brace pattern keeps this to one watcher rather than a dozen.
    const pattern = `**/{${names.join(',')},requirements-*.txt}`;

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange((uri) => this.schedule(uri));
    watcher.onDidCreate((uri) => this.schedule(uri));
    watcher.onDidDelete((uri) => this.schedule(uri));
    this.watchers.push(watcher);
  }

  /**
   * Coalesces bursts — an install rewrites the manifest and lockfile together.
   *
   * Paths the scan would ignore are dropped before the debounce rather than
   * after: `npm install` writes thousands of `package.json` files under
   * `node_modules`, none of which change what Panorama displays.
   */
  private schedule(uri: vscode.Uri): void {
    if (isExcluded(uri)) return;

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
  }
}

/**
 * Whether a changed file sits somewhere `panorama.excludeGlobs` rules out.
 *
 * Matched with a plain segment test rather than a glob engine: the setting's
 * entries are directory patterns (`**​/node_modules/**`), and the only question
 * that matters is whether the path runs through one of those directories.
 */
function isExcluded(uri: vscode.Uri): boolean {
  const globs = vscode.workspace
    .getConfiguration('panorama')
    .get<string[]>('excludeGlobs', []);

  const segments = new Set(uri.path.split('/'));

  return globs.some((glob) => {
    const directory = /^\*\*\/(.+?)\/\*\*$/.exec(glob)?.[1];
    // Anything that is not a simple `**/dir/**` pattern is left to the scan,
    // which has the real glob engine.
    return directory !== undefined && segments.has(directory);
  });
}
