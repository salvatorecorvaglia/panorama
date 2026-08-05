/**
 * The mute list.
 *
 * The subtle rule is that a mute is scoped to the version it was taken against:
 * silencing "1.0 → 2.0" must not also silence 3.0 when it lands, or the feature
 * quietly becomes "never tell me about this package again".
 */

import { describe, expect, it } from 'vitest';
import { type Memento, MuteList } from '../../src/core/muteList.js';
import type { Dependency } from '../../src/core/types.js';

function makeMemento(): Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: 'k',
    name: 'lodash',
    ecosystem: 'node',
    scope: 'prod',
    declared: '^4.0.0',
    installed: '4.17.15',
    latest: '4.18.1',
    updateKind: 'minor',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'p',
    ...overrides,
  };
}

describe('MuteList', () => {
  it('mutes and unmutes a package', async () => {
    const list = new MuteList(makeMemento());
    expect(list.isMuted(dep())).toBe(false);

    await list.mute(dep());
    expect(list.isMuted(dep())).toBe(true);

    await list.unmute(dep());
    expect(list.isMuted(dep())).toBe(false);
  });

  it('toggles and reports the resulting state', async () => {
    const list = new MuteList(makeMemento());
    expect(await list.toggle(dep())).toBe(true);
    expect(await list.toggle(dep())).toBe(false);
  });

  it('scopes a mute to the version it was taken against', async () => {
    const list = new MuteList(makeMemento());
    await list.mute(dep({ latest: '4.18.1' }));

    // Same version: still muted.
    expect(list.isMuted(dep({ latest: '4.18.1' }))).toBe(true);
    // A newer release lapses the mute, so the user hears about it once.
    expect(list.isMuted(dep({ latest: '5.0.0' }))).toBe(false);
  });

  it('keeps packages of the same name in different ecosystems separate', async () => {
    const list = new MuteList(makeMemento());
    await list.mute(
      dep({ name: 'requests', ecosystem: 'python', latest: '2.0.0' }),
    );

    expect(
      list.isMuted(
        dep({ name: 'requests', ecosystem: 'python', latest: '2.0.0' }),
      ),
    ).toBe(true);
    expect(
      list.isMuted(
        dep({ name: 'requests', ecosystem: 'node', latest: '2.0.0' }),
      ),
    ).toBe(false);
  });

  it('survives being reconstructed from storage', async () => {
    const memento = makeMemento();
    const first = new MuteList(memento);
    await first.mute(dep());

    // A new window builds a fresh MuteList over the same workspaceState.
    const second = new MuteList(memento);
    expect(second.isMuted(dep())).toBe(true);
    expect(second.size).toBe(1);
  });

  it('stamps the muted flag onto dependencies', async () => {
    const list = new MuteList(makeMemento());
    await list.mute(dep({ name: 'lodash' }));

    const deps = [
      dep({ name: 'lodash' }),
      dep({ name: 'express', latest: '5.0.0' }),
    ];
    list.applyTo(deps);

    expect(deps[0].muted).toBe(true);
    expect(deps[1].muted).toBe(false);
  });

  it('clears everything at once', async () => {
    const list = new MuteList(makeMemento());
    await list.mute(dep({ name: 'a' }));
    await list.mute(dep({ name: 'b' }));
    expect(list.size).toBe(2);

    await list.clear();
    expect(list.size).toBe(0);
    expect(list.isMuted(dep({ name: 'a' }))).toBe(false);
  });
});
