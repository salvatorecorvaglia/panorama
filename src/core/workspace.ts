/**
 * The VS Code-facing adapter that providers talk to.
 *
 * Providers are deliberately free of any `vscode` import so they stay unit
 * testable; this class supplies the file access and settings they need.
 */

import * as vscode from 'vscode';
import type { ProviderContext } from '../providers/provider.js';
import type { TtlCache } from './cache.js';
import type { HttpClient } from './http.js';
import type { Ecosystem } from './types.js';

export function createProviderContext(
  http: HttpClient,
  cache: TtlCache,
): ProviderContext {
  return {
    http,
    cache,

    async readFile(absolutePath: string): Promise<string | null> {
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(absolutePath),
        );
        return Buffer.from(bytes).toString('utf8');
      } catch {
        return null;
      }
    },

    async exists(absolutePath: string): Promise<boolean> {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
        return true;
      } catch {
        return false;
      }
    },

    registryOverride(ecosystem: Ecosystem): string | undefined {
      const overrides = vscode.workspace
        .getConfiguration('panorama')
        .get<Record<string, string>>('registryOverrides', {});
      // Accept both the ecosystem id and its common alias, so users can write
      // "npm" rather than having to know we call it "node" internally.
      const alias =
        ecosystem === 'node'
          ? 'npm'
          : ecosystem === 'python'
            ? 'pypi'
            : ecosystem;
      const value = overrides[ecosystem] ?? overrides[alias];
      return value?.replace(/\/$/, '');
    },

    preferredToolchain(ecosystem: Ecosystem): string {
      const config = vscode.workspace.getConfiguration('panorama');
      if (ecosystem === 'node')
        return config.get<string>('preferredNodeManager', 'auto');
      if (ecosystem === 'python')
        return config.get<string>('pythonManager', 'auto');
      return 'auto';
    },
  };
}
