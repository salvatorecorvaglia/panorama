/**
 * `resolveRegistryOverride`: alias resolution, trimming, and the http(s)-only
 * scheme check that keeps `panorama.registryOverrides` from sending a
 * malformed or exotic URL straight to `fetch()`.
 */

import { describe, expect, it } from 'vitest';
import { resolveRegistryOverride } from '../../src/core/registryOverride.js';

describe('resolveRegistryOverride', () => {
  it('returns undefined when nothing is configured for the ecosystem', () => {
    expect(resolveRegistryOverride({}, 'cargo')).toBeUndefined();
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal' }, 'maven'),
    ).toBeUndefined();
  });

  it('matches the ecosystem id directly for ecosystems with no alias', () => {
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal' }, 'cargo'),
    ).toBe('https://cargo.internal');
  });

  it('accepts the common alias so users need not know the internal id', () => {
    expect(
      resolveRegistryOverride({ npm: 'https://npm.internal' }, 'node'),
    ).toBe('https://npm.internal');
    expect(
      resolveRegistryOverride({ pypi: 'https://pypi.internal' }, 'python'),
    ).toBe('https://pypi.internal');
  });

  it('prefers the internal id over the alias when both are set', () => {
    expect(
      resolveRegistryOverride(
        { node: 'https://node-wins.internal', npm: 'https://alias.internal' },
        'node',
      ),
    ).toBe('https://node-wins.internal');
  });

  it('strips one or more trailing slashes', () => {
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal/' }, 'cargo'),
    ).toBe('https://cargo.internal');
    expect(
      resolveRegistryOverride({ cargo: 'https://cargo.internal//' }, 'cargo'),
    ).toBe('https://cargo.internal');
  });

  it('trims surrounding whitespace', () => {
    expect(
      resolveRegistryOverride({ cargo: '  https://cargo.internal  ' }, 'cargo'),
    ).toBe('https://cargo.internal');
  });

  it('accepts http as well as https', () => {
    expect(
      resolveRegistryOverride({ cargo: 'http://cargo.internal' }, 'cargo'),
    ).toBe('http://cargo.internal');
  });

  it('rejects a non-http(s) scheme rather than passing it to fetch()', () => {
    expect(
      resolveRegistryOverride({ cargo: 'file:///etc/passwd' }, 'cargo'),
    ).toBeUndefined();
    expect(
      resolveRegistryOverride({ cargo: 'javascript:alert(1)' }, 'cargo'),
    ).toBeUndefined();
    expect(
      resolveRegistryOverride({ cargo: 'ftp://cargo.internal' }, 'cargo'),
    ).toBeUndefined();
  });

  it('rejects a value that is not a URL at all', () => {
    expect(
      resolveRegistryOverride({ cargo: 'not a url' }, 'cargo'),
    ).toBeUndefined();
    expect(resolveRegistryOverride({ cargo: '' }, 'cargo')).toBeUndefined();
  });
});
