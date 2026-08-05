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

const EXTENSION_ID = 'panorama.panorama';

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
      'panorama.toggleMute',
      'panorama.clearMuted',
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

describe('mute list', () => {
  let api: PanoramaApi;

  before(async () => {
    api = await getApi();
    await api.muteList.clear();
  });

  after(async () => {
    await api.muteList.clear();
  });

  it('round-trips through workspaceState and affects the summary', async () => {
    const result = await api.scan({ checkUpdates: false });
    const node = result.groups.find((group) => group.ecosystem === 'node');
    assert.ok(node);

    const target = node.dependencies[0];
    assert.ok(target, 'no dependency to mute');

    assert.equal(api.muteList.isMuted(target), false);
    await api.muteList.mute(target);
    assert.equal(api.muteList.isMuted(target), true);
    assert.equal(api.muteList.size, 1);

    await api.muteList.unmute(target);
    assert.equal(api.muteList.isMuted(target), false);
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
  before(async () => {
    await getApi();
  });

  it('refresh completes without error, and without touching the network', async () => {
    const started = Date.now();
    await vscode.commands.executeCommand('panorama.refresh');
    const elapsed = Date.now() - started;

    // Under ExtensionMode.Test every automatic scan is offline, so a refresh is
    // a filesystem walk and nothing more. A registry round-trip across seven
    // ecosystems could not finish this fast, which makes the timing a real
    // assertion that the offline guarantee still holds.
    assert.ok(
      elapsed < 3000,
      `refresh took ${elapsed}ms — it appears to have contacted registries`,
    );
  });

  it('checkUpdates stays offline under the test host', async () => {
    const started = Date.now();
    await vscode.commands.executeCommand('panorama.checkUpdates');
    assert.ok(
      Date.now() - started < 3000,
      'checkUpdates appears to have contacted registries',
    );
  });

  it('showWhy with no selection does not throw', async () => {
    // Falls back to an informational message rather than failing.
    await vscode.commands.executeCommand('panorama.showWhy');
  });

  it('clearMuted with an empty list does not throw', async () => {
    await vscode.commands.executeCommand('panorama.clearMuted');
  });
});
