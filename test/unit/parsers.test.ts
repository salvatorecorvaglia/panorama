/**
 * Manifest parsing across all seven ecosystems.
 *
 * Each ecosystem gets the shapes that actually appear in real projects — not
 * just the happy path — because a parser that silently drops a dependency is
 * worse than one that fails loudly.
 */

import { describe, expect, it } from 'vitest';
import { CargoProvider } from '../../src/providers/cargo/index.js';
import { ComposerProvider } from '../../src/providers/composer/index.js';
import {
  escapeModulePath,
  GoProvider,
} from '../../src/providers/golang/index.js';
import { GradleProvider } from '../../src/providers/gradle/index.js';
import { MavenProvider } from '../../src/providers/maven/index.js';
import { NodeProvider } from '../../src/providers/node/index.js';
import {
  normalizeName,
  PythonProvider,
  parseRequirement,
} from '../../src/providers/python/index.js';
import { providerForPath } from '../../src/providers/registry.js';
import { findDep, makeContext } from './helpers.js';

const ctx = makeContext();

describe('provider routing', () => {
  it('maps manifest filenames to the right provider', () => {
    expect(providerForPath('/p/package.json')?.id).toBe('node');
    expect(providerForPath('/p/pyproject.toml')?.id).toBe('python');
    expect(providerForPath('/p/requirements.txt')?.id).toBe('python');
    expect(providerForPath('/p/requirements-dev.txt')?.id).toBe('python');
    expect(providerForPath('/p/Cargo.toml')?.id).toBe('cargo');
    expect(providerForPath('/p/go.mod')?.id).toBe('golang');
    expect(providerForPath('/p/composer.json')?.id).toBe('composer');
    expect(providerForPath('/p/pom.xml')?.id).toBe('maven');
    expect(providerForPath('/p/build.gradle.kts')?.id).toBe('gradle');
    expect(providerForPath('/p/README.md')).toBeUndefined();
  });
});

describe('Node provider', () => {
  const provider = new NodeProvider();

  it('reads every dependency bucket with the right scope', async () => {
    const manifest = await provider.parse(
      '/p/package.json',
      JSON.stringify({
        name: 'demo',
        dependencies: { react: '^18.2.0' },
        devDependencies: { vitest: '~2.1.0' },
        optionalDependencies: { fsevents: '*' },
        peerDependencies: { typescript: '>=5' },
      }),
      ctx,
    );

    expect(manifest.name).toBe('demo');
    expect(findDep(manifest.dependencies, 'react').scope).toBe('prod');
    expect(findDep(manifest.dependencies, 'vitest').scope).toBe('dev');
    expect(findDep(manifest.dependencies, 'fsevents').scope).toBe('optional');
    expect(findDep(manifest.dependencies, 'typescript').scope).toBe('peer');
  });

  it('detects workspaces in both array and object form', async () => {
    const array = await provider.parse(
      '/p/package.json',
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      ctx,
    );
    expect(array.workspaceMembers).toEqual(['packages/*']);
    expect(array.isWorkspaceRoot).toBe(true);

    const object = await provider.parse(
      '/p/package.json',
      JSON.stringify({ name: 'root', workspaces: { packages: ['apps/*'] } }),
      ctx,
    );
    expect(object.workspaceMembers).toEqual(['apps/*']);
  });

  it('picks the toolchain from lockfiles, in precedence order', async () => {
    const cases: Array<[string, string]> = [
      ['bun.lock', 'bun'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ];

    for (const [lockfile, expected] of cases) {
      const context = makeContext({
        '/p/package.json': '{}',
        [`/p/${lockfile}`]: '',
      });
      const toolchain = await provider.detectToolchain(
        '/p/package.json',
        context,
      );
      expect(toolchain.id, `${lockfile} should mean ${expected}`).toBe(
        expected,
      );
    }
  });

  it('lets the packageManager field override the lockfile', async () => {
    const context = makeContext({
      '/p/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/p/package-lock.json': '',
    });
    const toolchain = await provider.detectToolchain(
      '/p/package.json',
      context,
    );
    expect(toolchain.id).toBe('pnpm');
  });

  it('defaults to npm when nothing indicates otherwise', async () => {
    const toolchain = await provider.detectToolchain(
      '/p/package.json',
      makeContext({}),
    );
    expect(toolchain.id).toBe('npm');
  });

  it('reads resolved versions from a v3 package-lock', async () => {
    const context = makeContext({
      '/p/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'demo' },
          'node_modules/react': { version: '18.3.1' },
          'node_modules/foo/node_modules/react': { version: '17.0.0' },
        },
      }),
    });
    const resolved = await provider.readLockfile('/p', context);
    // The top-level install path wins over the nested one.
    expect(resolved.get('react')).toBe('18.3.1');
  });

  it('validates package names, including scoped ones', () => {
    expect(provider.isValidPackageName('react')).toBe(true);
    expect(provider.isValidPackageName('@scope/pkg')).toBe(true);
    expect(provider.isValidPackageName('has spaces')).toBe(false);
    expect(provider.isValidPackageName('../evil')).toBe(false);
    expect(provider.isValidPackageName('a; rm -rf /')).toBe(false);
  });

  it('builds scope-correct commands per toolchain', () => {
    const pnpm = { id: 'pnpm' as const, ecosystem: 'node' as const, cwd: '/p' };
    expect(
      provider.installCommand(pnpm, 'vitest', '2.1.0', 'dev')?.argv,
    ).toEqual(['pnpm', 'add', 'vitest@2.1.0', '--dev']);

    const npm = { id: 'npm' as const, ecosystem: 'node' as const, cwd: '/p' };
    expect(provider.installCommand(npm, 'vitest', null, 'dev')?.argv).toEqual([
      'npm',
      'install',
      'vitest',
      '--save-dev',
    ]);
    expect(
      provider.uninstallCommand(npm, { name: 'react' } as never)?.argv,
    ).toEqual(['npm', 'uninstall', 'react']);
  });

  it('refuses to build a command for an invalid name', () => {
    const npm = { id: 'npm' as const, ecosystem: 'node' as const, cwd: '/p' };
    expect(
      provider.installCommand(npm, 'evil; rm -rf /', null, 'prod'),
    ).toBeNull();
  });
});

describe('Python provider', () => {
  const provider = new PythonProvider();

  it('parses PEP 621 dependencies and optional groups', async () => {
    const manifest = await provider.parse(
      '/p/pyproject.toml',
      `
[project]
name = "demo"
dependencies = [
  "requests>=2.28",
  "httpx[http2]==0.27.0",
  "tomli; python_version < '3.11'",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]
`,
      ctx,
    );

    expect(manifest.name).toBe('demo');
    expect(findDep(manifest.dependencies, 'requests').declared).toBe('>=2.28');
    // Extras are stripped from the name but the specifier survives.
    expect(findDep(manifest.dependencies, 'httpx').declared).toBe('==0.27.0');
    // Environment markers must not leak into the specifier.
    expect(findDep(manifest.dependencies, 'tomli').declared).toBe('');
    expect(findDep(manifest.dependencies, 'pytest').scope).toBe('dev');
  });

  it('parses Poetry tables including groups', async () => {
    const manifest = await provider.parse(
      '/p/pyproject.toml',
      `
[tool.poetry]
name = "poetry-demo"

[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.28"
django = { version = "^5.0", extras = ["bcrypt"] }

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
`,
      ctx,
    );

    // The interpreter constraint is not a package.
    expect(manifest.dependencies.some((dep) => dep.name === 'python')).toBe(
      false,
    );
    expect(findDep(manifest.dependencies, 'requests').declared).toBe('^2.28');
    expect(findDep(manifest.dependencies, 'django').declared).toBe('^5.0');
    expect(findDep(manifest.dependencies, 'pytest').scope).toBe('dev');
  });

  it('parses PEP 735 dependency groups', async () => {
    const manifest = await provider.parse(
      '/p/pyproject.toml',
      `
[project]
name = "demo"

[dependency-groups]
test = ["pytest>=8"]
`,
      ctx,
    );
    expect(findDep(manifest.dependencies, 'pytest').scope).toBe('dev');
  });

  it('parses requirements.txt and skips non-package lines', async () => {
    const manifest = await provider.parse(
      '/p/requirements.txt',
      `
# a comment
--index-url https://example.com/simple
-r other.txt
-e .
https://example.com/pkg.whl
./local-package

requests==2.31.0
flask>=2,<3  # inline comment
`,
      ctx,
    );

    expect(manifest.dependencies.map((dep) => dep.name).sort()).toEqual([
      'flask',
      'requests',
    ]);
    expect(findDep(manifest.dependencies, 'requests').declared).toBe(
      '==2.31.0',
    );
    expect(findDep(manifest.dependencies, 'flask').declared).toBe('>=2,<3');
  });

  it('treats a dev-named requirements file as dev scope', async () => {
    const manifest = await provider.parse(
      '/p/requirements-dev.txt',
      'pytest==8.0.0',
      ctx,
    );
    expect(manifest.dependencies[0].scope).toBe('dev');
  });

  it('detects the toolchain from lockfiles and pyproject markers', async () => {
    expect(
      (
        await provider.detectToolchain(
          '/p/pyproject.toml',
          makeContext({ '/p/uv.lock': '' }),
        )
      ).id,
    ).toBe('uv');
    expect(
      (
        await provider.detectToolchain(
          '/p/pyproject.toml',
          makeContext({ '/p/poetry.lock': '' }),
        )
      ).id,
    ).toBe('poetry');
    expect(
      (
        await provider.detectToolchain(
          '/p/pyproject.toml',
          makeContext({ '/p/pyproject.toml': '[tool.poetry]\nname="x"' }),
        )
      ).id,
    ).toBe('poetry');
    expect(
      (await provider.detectToolchain('/p/pyproject.toml', makeContext({}))).id,
    ).toBe('pip');
  });

  it('normalises names per PEP 503', () => {
    expect(normalizeName('Flask_SQLAlchemy')).toBe('flask-sqlalchemy');
    expect(normalizeName('zope.interface')).toBe('zope-interface');
    expect(normalizeName('a--b')).toBe('a-b');
  });

  it('splits requirement strings', () => {
    expect(
      parseRequirement('requests[security]>=2.0; python_version<"3.11"'),
    ).toEqual({
      name: 'requests',
      extras: ['security'],
      specifier: '>=2.0',
    });
  });

  it('edits requirements.txt while preserving comments and order', () => {
    const original = '# header\nrequests==2.28.0  # pinned\nflask>=2\n';

    const updated = provider.editManifest(original, {
      kind: 'update',
      name: 'requests',
      version: '2.31.0',
      scope: 'prod',
    });
    expect(updated).toContain('requests==2.31.0  # pinned');
    expect(updated).toContain('# header');
    expect(updated).toContain('flask>=2');

    const added = provider.editManifest(original, {
      kind: 'add',
      name: 'httpx',
      version: '0.27.0',
      scope: 'prod',
    });
    expect(added).toContain('httpx==0.27.0');

    const removed = provider.editManifest(original, {
      kind: 'remove',
      name: 'requests',
      scope: 'prod',
    });
    expect(removed).not.toContain('requests');
    expect(removed).toContain('flask>=2');
  });

  it('builds the right command per Python toolchain', () => {
    const uv = { id: 'uv' as const, ecosystem: 'python' as const, cwd: '/p' };
    expect(provider.installCommand(uv, 'pytest', null, 'dev')?.argv).toEqual([
      'uv',
      'add',
      '--dev',
      'pytest',
    ]);

    const poetry = {
      id: 'poetry' as const,
      ecosystem: 'python' as const,
      cwd: '/p',
    };
    expect(
      provider.installCommand(poetry, 'pytest', '8.0.0', 'dev')?.argv,
    ).toEqual(['poetry', 'add', '--group', 'dev', 'pytest==8.0.0']);
  });
});

describe('Cargo provider', () => {
  const provider = new CargoProvider();

  it('parses string and table dependency forms', async () => {
    const manifest = await provider.parse(
      '/p/Cargo.toml',
      `
[package]
name = "demo"

[dependencies]
serde = "1.0"
tokio = { version = "1.35", features = ["full"] }
local = { path = "../local" }
from-git = { git = "https://example.com/repo" }

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1.0"
`,
      ctx,
    );

    expect(findDep(manifest.dependencies, 'serde').declared).toBe('1.0');
    expect(findDep(manifest.dependencies, 'tokio').declared).toBe('1.35');
    expect(findDep(manifest.dependencies, 'criterion').scope).toBe('dev');
    expect(findDep(manifest.dependencies, 'cc').scope).toBe('build');

    // Path and git dependencies have no registry version, so they are excluded.
    expect(manifest.dependencies.some((dep) => dep.name === 'local')).toBe(
      false,
    );
    expect(manifest.dependencies.some((dep) => dep.name === 'from-git')).toBe(
      false,
    );
  });

  it('recognises a virtual workspace manifest', async () => {
    const manifest = await provider.parse(
      '/p/Cargo.toml',
      `[workspace]\nmembers = ["crates/*"]`,
      ctx,
    );
    expect(manifest.isWorkspaceRoot).toBe(true);
    expect(manifest.workspaceMembers).toEqual(['crates/*']);
  });

  it('reads Cargo.lock', async () => {
    const context = makeContext({
      '/p/Cargo.lock': `
[[package]]
name = "serde"
version = "1.0.200"

[[package]]
name = "tokio"
version = "1.35.1"
`,
    });
    const resolved = await provider.readLockfile('/p', context);
    expect(resolved.get('serde')).toBe('1.0.200');
    expect(resolved.get('tokio')).toBe('1.35.1');
  });

  it('builds cargo commands', () => {
    const toolchain = {
      id: 'cargo' as const,
      ecosystem: 'cargo' as const,
      cwd: '/p',
    };
    expect(
      provider.installCommand(toolchain, 'serde', '1.0.200', 'dev')?.argv,
    ).toEqual(['cargo', 'add', 'serde@1.0.200', '--dev']);
  });
});

describe('Go provider', () => {
  const provider = new GoProvider();

  it('parses require blocks and marks indirect modules', async () => {
    const manifest = await provider.parse(
      '/p/go.mod',
      `
module example.com/demo

go 1.22

require (
	github.com/gin-gonic/gin v1.10.0
	golang.org/x/text v0.14.0 // indirect
)

require github.com/spf13/cobra v1.8.0
`,
      ctx,
    );

    expect(manifest.name).toBe('example.com/demo');
    expect(
      findDep(manifest.dependencies, 'github.com/gin-gonic/gin').scope,
    ).toBe('prod');
    expect(
      findDep(manifest.dependencies, 'github.com/gin-gonic/gin').installed,
    ).toBe('v1.10.0');
    // Indirect requirements are transitive, so they are not shown as direct.
    expect(findDep(manifest.dependencies, 'golang.org/x/text').scope).toBe(
      'optional',
    );
    expect(
      findDep(manifest.dependencies, 'github.com/spf13/cobra').declared,
    ).toBe('v1.8.0');
  });

  it('case-escapes module paths for the proxy', () => {
    expect(escapeModulePath('github.com/BurntSushi/toml')).toBe(
      'github.com/!burnt!sushi/toml',
    );
    expect(escapeModulePath('github.com/spf13/cobra')).toBe(
      'github.com/spf13/cobra',
    );
  });

  it('removes a module with @none', () => {
    const toolchain = {
      id: 'go' as const,
      ecosystem: 'golang' as const,
      cwd: '/p',
    };
    expect(
      provider.uninstallCommand(toolchain, { name: 'example.com/m' } as never)
        ?.argv,
    ).toEqual(['go', 'get', 'example.com/m@none']);
  });
});

describe('Composer provider', () => {
  const provider = new ComposerProvider();

  it('parses require blocks and drops platform requirements', async () => {
    const manifest = await provider.parse(
      '/p/composer.json',
      JSON.stringify({
        name: 'acme/demo',
        require: { php: '^8.2', 'ext-json': '*', 'monolog/monolog': '^3.0' },
        'require-dev': { 'phpunit/phpunit': '^11.0' },
      }),
      ctx,
    );

    expect(manifest.dependencies.map((dep) => dep.name).sort()).toEqual([
      'monolog/monolog',
      'phpunit/phpunit',
    ]);
    expect(findDep(manifest.dependencies, 'phpunit/phpunit').scope).toBe('dev');
  });

  it('validates vendor/package names', () => {
    expect(provider.isValidPackageName('monolog/monolog')).toBe(true);
    expect(provider.isValidPackageName('nopart')).toBe(false);
    expect(provider.isValidPackageName('Bad/Case')).toBe(false);
  });

  it('reads composer.lock and strips the v prefix', async () => {
    const context = makeContext({
      '/p/composer.lock': JSON.stringify({
        packages: [{ name: 'monolog/monolog', version: 'v3.5.0' }],
        'packages-dev': [{ name: 'phpunit/phpunit', version: '11.0.1' }],
      }),
    });
    const resolved = await provider.readLockfile('/p', context);
    expect(resolved.get('monolog/monolog')).toBe('3.5.0');
    expect(resolved.get('phpunit/phpunit')).toBe('11.0.1');
  });
});

describe('Maven provider', () => {
  const provider = new MavenProvider();

  const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <groupId>com.acme</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
  <properties>
    <junit.version>5.10.2</junit.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.google.guava</groupId>
        <artifactId>guava</artifactId>
        <version>33.0.0-jre</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>\${junit.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
    </dependency>
  </dependencies>
</project>`;

  it('resolves property placeholders and managed versions', async () => {
    const manifest = await provider.parse('/p/pom.xml', pom, ctx);

    const junit = findDep(
      manifest.dependencies,
      'org.junit.jupiter:junit-jupiter',
    );
    expect(junit.declared).toBe('5.10.2');
    expect(junit.scope).toBe('dev'); // <scope>test</scope>

    // The version comes from <dependencyManagement>, not the element itself.
    const guava = findDep(manifest.dependencies, 'com.google.guava:guava');
    expect(guava.declared).toBe('33.0.0-jre');
  });

  it('maps provided scope onto build', async () => {
    const manifest = await provider.parse(
      '/p/pom.xml',
      `<project><dependencies><dependency>
        <groupId>javax.servlet</groupId><artifactId>servlet-api</artifactId>
        <version>4.0.1</version><scope>provided</scope>
      </dependency></dependencies></project>`,
      ctx,
    );
    expect(manifest.dependencies[0].scope).toBe('build');
  });

  it('rewrites a version without reflowing the file', () => {
    const updated = provider.editManifest(pom, {
      kind: 'update',
      name: 'com.google.guava:guava',
      version: '33.1.0-jre',
      scope: 'prod',
    });
    // The managed block is the only one with a <version> for guava.
    expect(updated).toContain('33.1.0-jre');
    // Untouched parts of the document must survive byte for byte.
    expect(updated).toContain('<artifactId>junit-jupiter</artifactId>');
    expect(updated).toContain('<junit.version>5.10.2</junit.version>');
  });

  it('adds a dependency before the closing tag', () => {
    const updated = provider.editManifest(pom, {
      kind: 'add',
      name: 'org.slf4j:slf4j-api',
      version: '2.0.13',
      scope: 'prod',
    });
    expect(updated).toContain('<artifactId>slf4j-api</artifactId>');
    expect(updated).toContain('<version>2.0.13</version>');
    expect(updated!.indexOf('slf4j-api')).toBeLessThan(
      updated!.lastIndexOf('</dependencies>'),
    );
  });
});

describe('Gradle provider', () => {
  const provider = new GradleProvider();

  it('parses literal declarations in a build script', async () => {
    const manifest = await provider.parse(
      '/p/build.gradle.kts',
      `
dependencies {
    implementation("com.google.guava:guava:33.0.0-jre")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    compileOnly("org.projectlombok:lombok:1.18.30")
    // implementation("commented:out:1.0")
    implementation("dynamic:version:$someVar")
}
`,
      ctx,
    );

    expect(
      findDep(manifest.dependencies, 'com.google.guava:guava').declared,
    ).toBe('33.0.0-jre');
    expect(
      findDep(manifest.dependencies, 'org.junit.jupiter:junit-jupiter').scope,
    ).toBe('dev');
    expect(
      findDep(manifest.dependencies, 'org.projectlombok:lombok').scope,
    ).toBe('build');

    // A commented-out dependency is not a dependency.
    expect(
      manifest.dependencies.some((dep) => dep.name === 'commented:out'),
    ).toBe(false);

    // A computed version must not be reported as if it were literal.
    expect(findDep(manifest.dependencies, 'dynamic:version').declared).toBe(
      'unspecified',
    );
  });

  it('parses version catalogs including version.ref indirection', async () => {
    const manifest = await provider.parse(
      '/p/gradle/libs.versions.toml',
      `
[versions]
junit = "5.10.2"

[libraries]
guava = { module = "com.google.guava:guava", version = "33.0.0-jre" }
junit-jupiter = { module = "org.junit.jupiter:junit-jupiter", version.ref = "junit" }
split = { group = "org.slf4j", name = "slf4j-api", version = "2.0.13" }
shorthand = "commons-io:commons-io:2.15.1"
`,
      ctx,
    );

    expect(
      findDep(manifest.dependencies, 'com.google.guava:guava').declared,
    ).toBe('33.0.0-jre');
    // The ref must resolve through the [versions] table.
    expect(
      findDep(manifest.dependencies, 'org.junit.jupiter:junit-jupiter')
        .declared,
    ).toBe('5.10.2');
    expect(findDep(manifest.dependencies, 'org.slf4j:slf4j-api').declared).toBe(
      '2.0.13',
    );
    expect(
      findDep(manifest.dependencies, 'commons-io:commons-io').declared,
    ).toBe('2.15.1');
  });

  it('updates a literal version in a build script', () => {
    const source = `implementation("com.google.guava:guava:33.0.0-jre")`;
    expect(
      provider.editManifest(source, {
        kind: 'update',
        name: 'com.google.guava:guava',
        version: '33.1.0-jre',
        scope: 'prod',
      }),
    ).toBe(`implementation("com.google.guava:guava:33.1.0-jre")`);
  });

  it('declines to edit what it cannot rewrite safely', () => {
    // Adding needs a configuration and an insertion point we cannot infer.
    expect(
      provider.editManifest('dependencies {}', {
        kind: 'add',
        name: 'a:b',
        version: '1.0',
        scope: 'prod',
      }),
    ).toBeNull();

    // A version held in a variable is not a literal we can replace.
    expect(
      provider.editManifest('implementation("a:b:$version")', {
        kind: 'update',
        name: 'a:b',
        version: '2.0',
        scope: 'prod',
      }),
    ).toBeNull();
  });
});
