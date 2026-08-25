/**
 * The pure part of `ProviderContext.registryOverride`: alias resolution,
 * trimming, and the http(s)-only scheme check that stops a malformed or
 * exotic URL from reaching `fetch()` unexamined.
 *
 * Kept apart from `workspace.ts`'s `vscode.workspace.getConfiguration` read
 * so it can be unit tested directly — that file imports `vscode`, which does
 * not exist outside the editor and so cannot be loaded here at all.
 */

import type { Ecosystem } from './types.js';

export function resolveRegistryOverride(
  overrides: Record<string, string>,
  ecosystem: Ecosystem,
): string | undefined {
  // Accept both the ecosystem id and its common alias, so users can write
  // "npm" rather than having to know we call it "node" internally.
  const alias =
    ecosystem === 'node' ? 'npm' : ecosystem === 'python' ? 'pypi' : ecosystem;
  const value = overrides[ecosystem] ?? overrides[alias];
  if (!value) return undefined;

  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const scheme = new URL(trimmed).protocol;
    if (scheme !== 'https:' && scheme !== 'http:') return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}
