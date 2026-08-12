/**
 * The single source of truth for host <-> webview messaging.
 *
 * Both sides import these types, so a mismatch is a compile error rather than a
 * runtime surprise. Like `types.ts`, this file must not import `vscode`.
 */

import type {
  DepNode,
  DepScope,
  Ecosystem,
  PackageMeta,
  ProjectGroup,
  ScanSummary,
  SearchResult,
} from './types.js';

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'checkUpdates' }
  | {
      type: 'search';
      query: string;
      ecosystem: Ecosystem | 'all';
      requestId: string;
    }
  | { type: 'cancelSearch'; requestId: string }
  | {
      type: 'install';
      name: string;
      version: string | null;
      scope: DepScope;
      manifestPath: string;
    }
  | { type: 'update'; depKey: string; toVersion: string }
  | { type: 'updateAll'; manifestPath: string }
  | { type: 'uninstall'; depKey: string }
  | { type: 'requestDetails'; depKey: string }
  | { type: 'requestWhy'; depKey: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openManifest'; manifestPath: string; packageName?: string };

/** Messages the extension host sends to the webview. */
export type HostMessage =
  | { type: 'state'; groups: ProjectGroup[]; summary: ScanSummary }
  /**
   * Lazily fetched metadata for one package.
   *
   * Deliberately narrower than `state`: re-posting the whole list when the
   * drawer fills in a size or a licence would resort the table under the
   * pointer of the user who just clicked a row.
   */
  | { type: 'depDetails'; depKey: string; meta: PackageMeta }
  | { type: 'scanning'; busy: boolean; label?: string }
  /**
   * `failed` names registries that did not answer. A partial result is still
   * worth showing, but silently omitting a whole ecosystem would leave the user
   * concluding the package does not exist.
   */
  | {
      type: 'searchResults';
      requestId: string;
      results: SearchResult[];
      failed: Ecosystem[];
    }
  | { type: 'searchError'; requestId: string; message: string }
  | {
      type: 'whyTree';
      depKey: string;
      roots: DepNode[];
      source: 'lockfile' | 'registry';
    }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  /** Opens the registry search UI — fired by the `panorama.searchInstall` command. */
  | { type: 'focusSearch' }
  /**
   * Selects a package and opens its detail drawer on the "why" section — fired
   * by `panorama.showWhy`, including from the tree view's context menu.
   */
  | { type: 'focusDependency'; depKey: string; reveal: 'details' | 'why' };

/**
 * The subset of the VS Code webview API we use. Declared here so the React app
 * has a type for `acquireVsCodeApi()` without pulling in `@types/vscode`.
 */
export interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}
