/**
 * Integration tests: a real VS Code, the real extension, the fixture workspace.
 *
 * These cover what unit tests structurally cannot — that the extension actually
 * activates, that its contributions are registered, and that the scanner finds
 * the manifests on disk through `workspace.findFiles` rather than a stub.
 *
 * Every scan here runs with `checkUpdates: false`, so the suite never touches
 * the network and stays deterministic in CI.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { PanoramaApi } from '../../src/extension.js';

const EXTENSION_ID = 'panorama.panorama-vscode';

async function getApi(): Promise<PanoramaApi> {
  const extension = vscode.extensions.getExtension<PanoramaApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not found`);
  const api = await extension.activate();
  assert.ok(api, 'activate() returned nothing');
  return api;
}

describe('activation', () => {
  it('activates in a workspace containing manifests', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension not installed in the test host');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  it('registers every contributed command', async () => {
    await getApi();
    const registered = await vscode.commands.getCommands(true);

    for (const command of [
      'panorama.open',
      'panorama.refresh',
      'panorama.checkUpdates',
      'panorama.updateAll',
      'panorama.searchInstall',
      'panorama.showWhy',
    ]) {
      assert.ok(registered.includes(command), `${command} was not registered`);
    }
  });
});

describe('scanner discovery', () => {
  let api: PanoramaApi;

  before(async () => {
    api = await getApi();
  });

  it('finds a project for every ecosystem in the fixtures', async () => {
    const result = await api.scan({ checkUpdates: false });

    const ecosystems = new Set(result.groups.map((group) => group.ecosystem));
    for (const expected of [
      'node',
      'python',
      'cargo',
      'golang',
      'composer',
      'maven',
      'gradle',
    ]) {
      assert.ok(
        ecosystems.has(expected as never),
        `no ${expected} project was discovered`,
      );
    }
  });

  it('parses dependencies with their scopes intact', async () => {
    const result = await api.scan({ checkUpdates: false });

    const node = result.groups.find((group) => group.ecosystem === 'node');
    assert.ok(node, 'node fixture missing');

    const names = node.dependencies.map((dep) => dep.name);
    assert.ok(names.includes('express'), 'express not parsed');
    assert.ok(names.includes('typescript'), 'typescript not parsed');

    const typescript = node.dependencies.find(
      (dep) => dep.name === 'typescript',
    );
    assert.equal(typescript?.scope, 'dev');

    const fsevents = node.dependencies.find((dep) => dep.name === 'fsevents');
    assert.equal(fsevents?.scope, 'optional');
  });

  it('detects the toolchain for each project', async () => {
    const result = await api.scan({ checkUpdates: false });

    const byEcosystem = new Map(
      result.groups.map((group) => [group.ecosystem, group.toolchain]),
    );
    assert.equal(byEcosystem.get('cargo'), 'cargo');
    assert.equal(byEcosystem.get('golang'), 'go');
    assert.equal(byEcosystem.get('composer'), 'composer');
    // No lockfile in the fixture, so npm is the documented default.
    assert.equal(byEcosystem.get('node'), 'npm');
  });

  it('resolves Maven property placeholders and managed versions', async () => {
    const result = await api.scan({ checkUpdates: false });

    const maven = result.groups.find((group) => group.ecosystem === 'maven');
    assert.ok(maven, 'maven fixture missing');

    const junit = maven.dependencies.find(
      (dep) => dep.name === 'org.junit.jupiter:junit-jupiter',
    );
    // ${junit.version} must have been expanded from <properties>.
    assert.equal(junit?.declared, '5.10.2');
    assert.equal(junit?.scope, 'dev');

    const guava = maven.dependencies.find(
      (dep) => dep.name === 'com.google.guava:guava',
    );
    // The version comes from <dependencyManagement>, not the element itself.
    assert.equal(guava?.declared, '32.0.0-jre');
  });

  it('reads the Gradle version catalog', async () => {
    const result = await api.scan({ checkUpdates: false });

    const gradle = result.groups.find((group) => group.ecosystem === 'gradle');
    assert.ok(gradle, 'gradle fixture missing');

    const junit = gradle.dependencies.find(
      (dep) => dep.name === 'org.junit.jupiter:junit-jupiter',
    );
    // version.ref = "junit" must resolve through the [versions] table.
    assert.equal(junit?.declared, '5.10.2');
  });

  it('separates requirements.txt from pyproject.toml', async () => {
    const result = await api.scan({ checkUpdates: false });

    const pythonGroups = result.groups.filter(
      (group) => group.ecosystem === 'python',
    );
    assert.ok(
      pythonGroups.length >= 2,
      'expected both Python manifests to be discovered',
    );

    const allNames = pythonGroups.flatMap((group) =>
      group.dependencies.map((dep) => dep.name),
    );
    assert.ok(allNames.includes('requests'), 'pyproject dependency missing');
    assert.ok(
      allNames.includes('flask'),
      'requirements.txt dependency missing',
    );
  });

  it('produces a summary consistent with the parsed groups', async () => {
    const result = await api.scan({ checkUpdates: false });

    const counted = result.groups.reduce(
      (total, group) => total + group.dependencies.length,
      0,
    );
    assert.equal(result.summary.totalDependencies, counted);
    // Nothing was version-checked, so nothing can be outdated yet.
    assert.equal(result.summary.outdated, 0);
  });

  it('excludes directories listed in panorama.excludeGlobs', async () => {
    const result = await api.scan({ checkUpdates: false });
    for (const group of result.groups) {
      assert.ok(
        !group.manifestPath.includes('node_modules'),
        `node_modules leaked into the scan: ${group.manifestPath}`,
      );
    }
  });
});

describe('tree view', () => {
  it('contributes the explorer view without throwing', async () => {
    await getApi();
    // Focusing the view forces VS Code to instantiate the TreeDataProvider,
    // which is where a malformed contribution would surface.
    await vscode.commands.executeCommand('panorama.explorer.focus');
  });
});

describe('commands are safe to invoke', () => {
  let api: PanoramaApi;

  before(async () => {
    api = await getApi();
  });

  /*
   * Under ExtensionMode.Test every automatic scan is offline, so a refresh is a
   * filesystem walk and nothing more.
   *
   * This is asserted against the client's own request counter rather than
   * against elapsed time. The previous version timed the command and inferred
   * from "under three seconds" that no registry had been contacted, which is
   * flaky on a loaded CI runner and, more to the point, is not evidence: a
   * cached or fast response would have passed it just as happily.
   */
  it('refresh completes without touching the network', async () => {
    const before = api.requestCount();
    await vscode.commands.executeCommand('panorama.refresh');
    assert.equal(
      api.requestCount(),
      before,
      'refresh issued network requests under the test host',
    );
  });

  it('checkUpdates stays offline under the test host', async () => {
    const before = api.requestCount();
    await vscode.commands.executeCommand('panorama.checkUpdates');
    assert.equal(
      api.requestCount(),
      before,
      'checkUpdates issued network requests under the test host',
    );
  });

  it('an explicitly offline scan through the API issues no requests', async () => {
    const before = api.requestCount();
    await api.scan({ checkUpdates: false, audit: false });
    assert.equal(api.requestCount(), before);
  });

  it('showWhy with no selection does not throw', async () => {
    // Falls back to an informational message rather than failing.
    await vscode.commands.executeCommand('panorama.showWhy');
  });
});
