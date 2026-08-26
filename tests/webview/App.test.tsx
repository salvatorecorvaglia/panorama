/**
 * The webview root: host-message routing and the states it puts the UI into.
 *
 * Messages are delivered the way the host delivers them — a `message` event on
 * `window` — so the bridge in `vscodeApi.ts` is exercised rather than bypassed.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { HostMessage } from '../../src/core/protocol.js';
import type { ProjectGroup, ScanSummary } from '../../src/core/types.js';
import { App } from '../../src/webview/App.js';
import { posted } from './setup.js';

const EMPTY_SUMMARY: ScanSummary = {
  totalDependencies: 0,
  outdated: 0,
  vulnerable: 0,
  deprecated: 0,
  stale: false,
};

function send(message: HostMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies: [
      {
        key: 'react',
        name: 'react',
        ecosystem: 'node',
        scope: 'prod',
        declared: '^18.0.0',
        installed: '18.0.0',
        latest: '19.0.0',
        updateKind: 'major',
        vulnerabilities: [],
        manifestPath: '/p/package.json',
        projectLabel: 'app',
      },
    ],
    ...overrides,
  };
}

/** Renders and completes the host handshake with one populated group. */
function renderLoaded(groups = [group()]) {
  const result = render(<App />);
  send({
    type: 'state',
    groups,
    summary: { ...EMPTY_SUMMARY, totalDependencies: groups.length },
  });
  return result;
}

describe('handshake', () => {
  it('announces itself so the host knows it can post', () => {
    render(<App />);
    expect(posted).toContainEqual({ type: 'ready' });
  });
});

describe('empty workspace', () => {
  it('offers a way into registry search', async () => {
    // Searching does not need a manifest — only installing does — so the
    // empty state has to keep the search panel reachable. The toolbar that
    // normally opens it is not rendered here.
    render(<App />);
    send({ type: 'state', groups: [], summary: EMPTY_SUMMARY });

    const open = screen.getByRole('button', {
      name: /Search.*package|Add package/i,
    });
    await userEvent.click(open);

    expect(
      screen.getByRole('searchbox', { name: /Search registries/i }),
    ).toBeInTheDocument();
  });

  it('still offers a rescan', async () => {
    render(<App />);
    send({ type: 'state', groups: [], summary: EMPTY_SUMMARY });

    await userEvent.click(screen.getByRole('button', { name: /Scan again/i }));
    expect(posted).toContainEqual({ type: 'refresh' });
  });
});

describe('notices and errors', () => {
  it('gives an error an assertive role and keeps it until dismissed', async () => {
    renderLoaded();
    send({ type: 'error', message: 'Something broke' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something broke');

    await userEvent.click(
      within(alert).getByRole('button', { name: /Dismiss/i }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps notices separate from errors so one cannot cut the other short', () => {
    renderLoaded();
    send({ type: 'error', message: 'the error' });
    send({ type: 'notice', message: 'the notice' });

    expect(screen.getByRole('alert')).toHaveTextContent('the error');
    expect(screen.getByText('the notice')).toBeInTheDocument();
  });

  /*
   * Errors used to occupy one slot, so the second silently replaced the first.
   * "Update all" against an unreachable registry produces one per package.
   */
  it('queues errors instead of letting a later one erase an earlier one', async () => {
    renderLoaded();
    send({ type: 'error', message: 'first failure' });
    send({ type: 'error', message: 'second failure' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('second failure');
    expect(alert).toHaveTextContent('and 1 earlier error');

    // Dismissing reveals the one behind it rather than discarding the queue.
    await userEvent.click(
      within(alert).getByRole('button', { name: /Dismiss/i }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('first failure');

    await userEvent.click(
      within(screen.getByRole('alert')).getByRole('button', {
        name: /Dismiss/i,
      }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not queue a repeat of the message already on screen', () => {
    renderLoaded();
    send({ type: 'error', message: 'same failure' });
    send({ type: 'error', message: 'same failure' });

    expect(screen.getByRole('alert')).not.toHaveTextContent('earlier');
  });

  it('caps the error queue rather than growing it without bound', () => {
    // "Update all" against a broken registry can fail once per package —
    // hundreds of distinct messages in a large monorepo.
    renderLoaded();
    for (let i = 0; i < 60; i++) {
      send({ type: 'error', message: `failure ${i}` });
    }

    const alert = screen.getByRole('alert');
    // The newest is always what is shown...
    expect(alert).toHaveTextContent('failure 59');
    // ...and the queue behind it is capped, not 59 deep.
    expect(alert).toHaveTextContent('and 49 earlier errors');
  });
});

describe('keyboard shortcuts', () => {
  it('sends Ctrl/Cmd+F to the filter box, which the editor Find cannot reach', async () => {
    renderLoaded();
    const filter = screen.getByRole('searchbox', {
      name: /Filter installed packages/i,
    });
    expect(document.activeElement).not.toBe(filter);

    await userEvent.keyboard('{Control>}f{/Control}');
    expect(document.activeElement).toBe(filter);
  });
});

describe('the why tree cache', () => {
  it('drops cached answers when a new scan arrives', async () => {
    // The graph can have changed under it, and a tree that is quietly one scan
    // stale looks exactly like a current one.
    renderLoaded();
    await userEvent.click(screen.getByText('react'));
    send({
      type: 'whyTree',
      depKey: 'react',
      source: 'lockfile',
      roots: [{ name: 'webpack', children: [] }],
    });
    expect(screen.getByText('webpack')).toBeInTheDocument();

    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });

    expect(screen.queryByText('webpack')).toBeNull();
    expect(screen.getByText(/Resolving/i)).toBeInTheDocument();
  });
});

describe('duplicate versions', () => {
  it('requests a check when the panel opens and shows what comes back', async () => {
    renderLoaded();
    await userEvent.click(
      screen.getByRole('button', { name: /Duplicate versions/i }),
    );
    expect(posted).toContainEqual({ type: 'requestDuplicates' });

    send({
      type: 'duplicateVersions',
      results: [
        {
          manifestPath: '/p/package.json',
          projectLabel: 'app',
          ecosystem: 'node',
          checked: true,
          groups: [{ name: 'ansi-styles', versions: ['3.2.1', '4.3.0'] }],
        },
      ],
    });

    expect(screen.getByText('ansi-styles')).toBeInTheDocument();
    expect(screen.getByText('3.2.1')).toBeInTheDocument();
    expect(screen.getByText('4.3.0')).toBeInTheDocument();
  });

  it('re-checks when a new scan lands while the panel stays open', async () => {
    renderLoaded();
    await userEvent.click(
      screen.getByRole('button', { name: /Duplicate versions/i }),
    );
    // The click itself already posted one request; a rescan must post another.
    const before = posted.length;

    send({ type: 'state', groups: [group()], summary: EMPTY_SUMMARY });

    expect(posted.length).toBeGreaterThan(before);
    expect(posted.at(-1)).toEqual({ type: 'requestDuplicates' });
  });

  it('says so when every checked project is clean', async () => {
    renderLoaded();
    await userEvent.click(
      screen.getByRole('button', { name: /Duplicate versions/i }),
    );
    send({
      type: 'duplicateVersions',
      results: [
        {
          manifestPath: '/p/package.json',
          projectLabel: 'app',
          ecosystem: 'node',
          checked: true,
          groups: [],
        },
      ],
    });

    expect(
      screen.getByText(/No duplicate versions found/i),
    ).toBeInTheDocument();
  });
});

describe('detail metadata', () => {
  it('merges into the open row without reordering the table', async () => {
    // A row that gains a size while sorted by Size must not jump out from
    // under the pointer of the user who just clicked it.
    renderLoaded();
    await userEvent.click(screen.getByText('react'));

    send({
      type: 'depDetails',
      depKey: 'react',
      meta: { name: 'react', sizeBytes: 1024 },
    });

    await waitFor(() => {
      expect(screen.getAllByText('1.0 KB').length).toBeGreaterThan(0);
    });
  });
});

describe('selection', () => {
  it('opens the drawer for the row the host asks to reveal', async () => {
    renderLoaded();
    send({ type: 'focusDependency', depKey: 'react', reveal: 'why' });

    await waitFor(() => {
      expect(
        screen.getByRole('complementary', { name: /Details for react/i }),
      ).toBeInTheDocument();
    });
    // Opening the drawer asks the host for the data it cannot compute itself.
    expect(posted).toContainEqual({ type: 'requestWhy', depKey: 'react' });
  });

  it('opens the search panel when the host asks for it', async () => {
    renderLoaded();
    send({ type: 'focusSearch' });

    await waitFor(() => {
      expect(
        screen.getByRole('searchbox', { name: /Search registries/i }),
      ).toBeInTheDocument();
    });
  });
});

describe('filtering', () => {
  it('narrows the table by name', async () => {
    renderLoaded([
      {
        ...group(),
        dependencies: [
          ...group().dependencies,
          {
            ...group().dependencies[0],
            key: 'lodash',
            name: 'lodash',
          },
        ],
      },
    ]);

    await userEvent.type(
      screen.getByRole('searchbox', { name: /Filter installed packages/i }),
      'loda',
    );

    await waitFor(() => {
      expect(screen.queryByText('react')).toBeNull();
    });
    expect(screen.getByText('lodash')).toBeInTheDocument();
  });
});

/*
 * Bulk actions used to post one message per selected package. The host handles
 * messages concurrently, so N messages meant N modal confirmations and N
 * commands racing on one terminal — the whole selection travels as one message
 * precisely so the host can confirm once and run them in order.
 */
describe('bulk actions', () => {
  function twoOutdated(): ProjectGroup {
    const base = group().dependencies[0];
    return {
      ...group(),
      dependencies: [
        base,
        { ...base, key: 'lodash', name: 'lodash', latest: '5.0.0' },
      ],
    };
  }

  async function selectAll() {
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Select all dependencies/i }),
    );
  }

  it('posts one bulkUpdate carrying every selected package', async () => {
    renderLoaded([twoOutdated()]);
    await selectAll();

    await userEvent.click(
      screen.getByRole('button', { name: /Update Selected/i }),
    );

    const bulk = posted.filter(
      (message): message is { type: string; targets: unknown[] } =>
        (message as { type?: string }).type === 'bulkUpdate',
    );
    expect(bulk).toHaveLength(1);
    expect(bulk[0].targets).toEqual([
      { depKey: 'react', toVersion: '19.0.0' },
      { depKey: 'lodash', toVersion: '5.0.0' },
    ]);
    // The per-package message is what raced; it must not be sent as well.
    expect(
      posted.filter((m) => (m as { type?: string }).type === 'update'),
    ).toHaveLength(0);
  });

  it('posts one bulkUninstall carrying every selected package', async () => {
    renderLoaded([twoOutdated()]);
    await selectAll();

    await userEvent.click(
      screen.getByRole('button', { name: /Remove Selected/i }),
    );

    const bulk = posted.filter(
      (message): message is { type: string; depKeys: string[] } =>
        (message as { type?: string }).type === 'bulkUninstall',
    );
    expect(bulk).toHaveLength(1);
    expect(bulk[0].depKeys.sort()).toEqual(['lodash', 'react']);
    expect(
      posted.filter((m) => (m as { type?: string }).type === 'uninstall'),
    ).toHaveLength(0);
  });

  it('says nothing when the selection has no upgrade to apply', async () => {
    // Selected, but already current: there is no version to update to, so the
    // host should not be asked to confirm an empty batch.
    const current = group().dependencies[0];
    renderLoaded([
      {
        ...group(),
        dependencies: [
          { ...current, latest: undefined, updateKind: 'none' as const },
        ],
      },
    ]);
    await selectAll();

    await userEvent.click(
      screen.getByRole('button', { name: /Update Selected/i }),
    );

    expect(
      posted.filter((m) => (m as { type?: string }).type === 'bulkUpdate'),
    ).toHaveLength(0);
  });
});

/*
 * The toolbar's count is the whole workspace's, so its action has to be too.
 * It used to pass `groups[0]` regardless, updating one project while the label
 * promised all of them.
 */
describe('global update all', () => {
  const outdatedSummary = {
    ...EMPTY_SUMMARY,
    totalDependencies: 2,
    outdated: 2,
  };

  function renderProjects(groups: ProjectGroup[]) {
    const result = render(<App />);
    send({ type: 'state', groups, summary: outdatedSummary });
    return result;
  }

  it('names the only project when there is just one', async () => {
    renderProjects([group()]);
    // The toolbar's button carries the workspace-wide count; the per-group
    // headers render an "Update all" of their own, which this must not match.
    await userEvent.click(
      screen.getByRole('button', { name: /Update All \(/ }),
    );

    expect(posted).toContainEqual({
      type: 'updateAll',
      manifestPath: '/p/package.json',
    });
  });

  it('names no project when there are several, so the host asks', async () => {
    renderProjects([
      group(),
      { ...group(), label: 'api', manifestPath: '/q/package.json' },
    ]);
    // The toolbar's button carries the workspace-wide count; the per-group
    // headers render an "Update all" of their own, which this must not match.
    await userEvent.click(
      screen.getByRole('button', { name: /Update All \(/ }),
    );

    const updateAll = posted.filter(
      (message): message is { type: string; manifestPath?: string } =>
        (message as { type?: string }).type === 'updateAll',
    );
    expect(updateAll).toHaveLength(1);
    expect(updateAll[0].manifestPath).toBeUndefined();
  });
});

/*
 * Selection has to survive filtering, and not survive a package disappearing.
 *
 * The bulk toolbar's accessible name carries the count, so these assert on
 * that rather than on body text — "Selected 2" and "Update Selected" both
 * contain the word.
 */
describe('selection bookkeeping', () => {
  function twoPackages(): ProjectGroup {
    const base = group().dependencies[0];
    return {
      ...group(),
      dependencies: [base, { ...base, key: 'lodash', name: 'lodash' }],
    };
  }

  /** The select-all box, whose label changes when a filter is applied. */
  function selectAllBox(): HTMLInputElement {
    return screen.getByRole('checkbox', {
      name: /Select all/i,
    }) as HTMLInputElement;
  }

  /** The per-row boxes, i.e. every checkbox that is not the header's. */
  function rowBoxes(): HTMLElement[] {
    const header = selectAllBox();
    return screen.getAllByRole('checkbox').filter((box) => box !== header);
  }

  function selectedCount(): number {
    const bar = screen.queryByRole('toolbar', { name: /Actions for/i });
    if (!bar) return 0;
    const label = bar.getAttribute('aria-label') ?? '';
    return Number(/Actions for (\d+)/.exec(label)?.[1] ?? 0);
  }

  /** The checkbox belonging to a named package's row. */
  function boxForRow(name: string): HTMLElement {
    const row = screen.getByText(name).closest('[role="row"]');
    if (!row) throw new Error(`no row for ${name}`);
    return within(row as HTMLElement).getByRole('checkbox');
  }

  it('keeps selections the filter is hiding when select-all is used', async () => {
    renderLoaded([twoPackages()]);

    // Select react specifically — it is the row the filter below will hide.
    await userEvent.click(boxForRow('react'));
    expect(selectedCount()).toBe(1);

    // Narrow to the other package, then select all of what is showing.
    await userEvent.type(
      screen.getByRole('searchbox', { name: /Filter installed packages/i }),
      'loda',
    );
    await waitFor(() => expect(screen.queryByText('react')).toBeNull());
    await userEvent.click(selectAllBox());

    // Both: replacing the set would have discarded the hidden row.
    await waitFor(() => expect(selectedCount()).toBe(2));
  });

  it('renames the select-all box when a filter is narrowing the list', async () => {
    renderLoaded([twoPackages()]);
    expect(
      screen.getByRole('checkbox', { name: /Select all dependencies/i }),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByRole('searchbox', { name: /Filter installed packages/i }),
      'loda',
    );

    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: /Select all matching/i }),
      ).toBeInTheDocument();
    });
  });

  it('drops selected rows a new scan no longer contains', async () => {
    renderLoaded([twoPackages()]);
    await userEvent.click(selectAllBox());
    expect(selectedCount()).toBe(2);

    // lodash has been uninstalled; its key now names nothing.
    send({
      type: 'state',
      groups: [group()],
      summary: { ...EMPTY_SUMMARY, totalDependencies: 1 },
    });

    await waitFor(() => expect(selectedCount()).toBe(1));
  });

  it('marks the select-all box indeterminate on a partial selection', async () => {
    renderLoaded([twoPackages()]);
    expect(selectAllBox().indeterminate).toBe(false);

    const boxes = rowBoxes();
    await userEvent.click(boxes[0]);

    // Neither all nor none, and the box has to say so rather than rendering
    // identically to an empty selection.
    await waitFor(() => expect(selectAllBox().indeterminate).toBe(true));
    expect(selectAllBox().checked).toBe(false);

    await userEvent.click(boxes[1]);
    await waitFor(() => expect(selectAllBox().indeterminate).toBe(false));
    expect(selectAllBox().checked).toBe(true);
  });
});
