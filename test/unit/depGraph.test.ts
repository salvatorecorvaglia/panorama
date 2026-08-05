/**
 * Reverse dependency resolution ("why is this installed?").
 *
 * Each lockfile format gets a sample in its real on-disk shape, because the
 * whole feature rests on parsing them correctly — a silently empty graph looks
 * identical to "no answer available".
 */

import { describe, expect, it } from 'vitest';
import { explainDependency } from '../../src/core/depGraph.js';
import type { Dependency } from '../../src/core/types.js';
import { makeContext } from './helpers.js';

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: 'k',
    name: 'ansi-styles',
    ecosystem: 'node',
    scope: 'prod',
    declared: '*',
    installed: '4.3.0',
    updateKind: 'unknown',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'p',
    ...overrides,
  };
}

/** Collects every name appearing anywhere in the returned tree. */
function flatten(nodes: Array<{ name: string; children: unknown[] }>): string[] {
  const out: string[] = [];
  const walk = (list: Array<{ name: string; children: unknown[] }>) => {
    for (const node of list) {
      out.push(node.name);
      walk(node.children as Array<{ name: string; children: unknown[] }>);
    }
  };
  walk(nodes);
  return out;
}

describe('npm package-lock.json', () => {
  it('traces a transitive package back to its direct dependent', async () => {
    const ctx = makeContext({
      '/p/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { chalk: '^4.0.0' } },
          'node_modules/chalk': { version: '4.1.2', dependencies: { 'ansi-styles': '^4.1.0' } },
          'node_modules/ansi-styles': { version: '4.3.0' },
        },
      }),
    });

    const result = await explainDependency(dep(), ctx);
    expect(result.source).toBe('lockfile');
    // chalk is why ansi-styles is present.
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });
});

describe('pnpm-lock.yaml', () => {
  it('parses the v9 snapshots layout', async () => {
    const ctx = makeContext({
      '/p/pnpm-lock.yaml': `lockfileVersion: '9.0'

snapshots:

  chalk@4.1.2:
    dependencies:
      ansi-styles: 4.3.0
      supports-color: 7.2.0

  ansi-styles@4.3.0:
    dependencies:
      color-convert: 2.0.1

  color-convert@2.0.1: {}
`,
    });

    const result = await explainDependency(dep(), ctx);
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });

  it('strips scopes and peer suffixes from package keys', async () => {
    const ctx = makeContext({
      '/p/pnpm-lock.yaml': `lockfileVersion: '9.0'

snapshots:

  '@babel/core@7.24.0(supports-color@8.1.1)':
    dependencies:
      '@babel/traverse': 7.24.0

  '@babel/traverse@7.24.0': {}
`,
    });

    const result = await explainDependency(dep({ name: '@babel/traverse' }), ctx);
    expect(result.source).toBe('lockfile');
    // The scope must survive and the (peer) suffix must not.
    expect(flatten(result.roots)).toEqual(['@babel/core', '@babel/traverse']);
  });
});

describe('yarn.lock', () => {
  it('parses v1 blocks', async () => {
    const ctx = makeContext({
      '/p/yarn.lock': `# yarn lockfile v1


chalk@^4.0.0:
  version "4.1.2"
  resolved "https://registry.yarnpkg.com/chalk/-/chalk-4.1.2.tgz"
  dependencies:
    ansi-styles "^4.1.0"
    supports-color "^7.1.0"

ansi-styles@^4.1.0:
  version "4.3.0"
  resolved "https://registry.yarnpkg.com/ansi-styles/-/ansi-styles-4.3.0.tgz"
  dependencies:
    color-convert "^2.0.1"
`,
    });

    const result = await explainDependency(dep(), ctx);
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['chalk', 'ansi-styles']);
  });
});

describe('Cargo.lock', () => {
  it('traces through the package array', async () => {
    const ctx = makeContext({
      '/p/Cargo.lock': `version = 3

[[package]]
name = "tokio"
version = "1.35.1"
dependencies = [
 "mio",
 "bytes",
]

[[package]]
name = "mio"
version = "0.8.10"
dependencies = [
 "libc",
]
`,
    });

    const result = await explainDependency(
      dep({ name: 'libc', ecosystem: 'cargo', manifestPath: '/p/Cargo.toml' }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['tokio', 'mio', 'libc']);
  });
});

describe('poetry.lock', () => {
  it('reads [package.dependencies] tables', async () => {
    const ctx = makeContext({
      '/p/poetry.lock': `[[package]]
name = "requests"
version = "2.31.0"

[package.dependencies]
urllib3 = ">=1.21.1,<3"
certifi = ">=2017.4.17"

[[package]]
name = "urllib3"
version = "2.2.1"
`,
    });

    const result = await explainDependency(
      dep({ name: 'urllib3', ecosystem: 'python', manifestPath: '/p/pyproject.toml' }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['requests', 'urllib3']);
  });
});

describe('uv.lock', () => {
  it('reads the dependencies array of tables', async () => {
    const ctx = makeContext({
      '/p/uv.lock': `version = 1

[[package]]
name = "requests"
version = "2.31.0"
dependencies = [
    { name = "urllib3" },
    { name = "certifi" },
]

[[package]]
name = "urllib3"
version = "2.2.1"
`,
    });

    const result = await explainDependency(
      dep({ name: 'urllib3', ecosystem: 'python', manifestPath: '/p/pyproject.toml' }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['requests', 'urllib3']);
  });

  it('normalises names per PEP 503 so underscores still match', async () => {
    const ctx = makeContext({
      '/p/uv.lock': `version = 1

[[package]]
name = "flask"
version = "3.0.0"
dependencies = [
    { name = "Jinja2" },
]

[[package]]
name = "jinja2"
version = "3.1.2"
`,
    });

    const result = await explainDependency(
      dep({ name: 'Jinja2', ecosystem: 'python', manifestPath: '/p/pyproject.toml' }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['flask', 'jinja2']);
  });
});

describe('composer.lock', () => {
  it('drops platform requirements from the graph', async () => {
    const ctx = makeContext({
      '/p/composer.lock': JSON.stringify({
        packages: [
          { name: 'laravel/framework', require: { php: '^8.2', 'psr/log': '^3.0' } },
          { name: 'psr/log', require: { php: '^8.0' } },
        ],
      }),
    });

    const result = await explainDependency(
      dep({ name: 'psr/log', ecosystem: 'composer', manifestPath: '/p/composer.json' }),
      ctx,
    );
    expect(result.source).toBe('lockfile');
    expect(flatten(result.roots)).toEqual(['laravel/framework', 'psr/log']);
  });
});

describe('cycle and depth safety', () => {
  it('terminates on a dependency cycle', async () => {
    const ctx = makeContext({
      '/p/Cargo.lock': `[[package]]
name = "a"
version = "1.0.0"
dependencies = [
 "b",
]

[[package]]
name = "b"
version = "1.0.0"
dependencies = [
 "a",
]
`,
    });

    const result = await explainDependency(
      dep({ name: 'a', ecosystem: 'cargo', manifestPath: '/p/Cargo.toml' }),
      ctx,
    );
    // The assertion that matters is that this returns at all.
    expect(result.roots.length).toBeGreaterThan(0);
  });
});

describe('graceful degradation', () => {
  it('reports no answer rather than throwing when no lockfile exists', async () => {
    const result = await explainDependency(dep(), makeContext({}));
    // The registry path is unreachable in tests, so this must fall back cleanly.
    expect(result.source).toBe('registry');
    expect(result.roots).toEqual([]);
  });
});
