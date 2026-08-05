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
    watcher.onDidChange(() => this.schedule());
    watcher.onDidCreate(() => this.schedule());
    watcher.onDidDelete(() => this.schedule());
    this.watchers.push(watcher);
  }

  /** Coalesces bursts — an install rewrites the manifest and lockfile together. */
  private schedule(): void {
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
