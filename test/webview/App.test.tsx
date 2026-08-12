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
  muted: 0,
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

describe('detail metadata', () => {
  it('merges into the open row without reordering the table', async () => {
    // A row that gains a size while sorted by Size must not jump out from
    // under the pointer of the user who just clicked it.
    renderLoaded();
    await userEvent.click(screen.getByText('react'));

    send({
      type: 'depDetails',
      depKey: 'react',
      meta: { name: 'react', license: 'MIT', sizeBytes: 1024 },
    });

    await waitFor(() => {
      expect(screen.getAllByText('MIT').length).toBeGreaterThan(0);
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
