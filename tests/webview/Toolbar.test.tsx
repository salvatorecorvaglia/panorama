/**
 * The toolbar: filters, the summary line, and its keyboard contract.
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScanSummary } from '../../src/core/types.js';
import { type Filters, Toolbar } from '../../src/webview/Toolbar.js';

const ALL: Filters = {
  text: '',
  scopes: new Set(['prod', 'dev', 'build', 'peer', 'optional']),
  onlyOutdated: false,
  onlyVulnerable: false,
  onlyDeprecated: false,
};

const SUMMARY: ScanSummary = {
  totalDependencies: 12,
  outdated: 3,
  vulnerable: 1,
  deprecated: 2,
  stale: false,
};

function renderToolbar(overrides: Partial<Parameters<typeof Toolbar>[0]> = {}) {
  const props = {
    filters: ALL,
    onFiltersChange: vi.fn(),
    summary: SUMMARY,
    busy: false,
    busyLabel: undefined,
    installOpen: false,
    onToggleInstall: vi.fn(),
    onRefresh: vi.fn(),
    onCheckUpdates: vi.fn(),
    ...overrides,
  };
  return { ...render(<Toolbar {...props} />), props };
}

describe('filters', () => {
  it('toggles a scope without disturbing the others', async () => {
    const onFiltersChange = vi.fn();
    renderToolbar({ onFiltersChange });

    await userEvent.click(screen.getByRole('button', { name: 'dev' }));

    const next = onFiltersChange.mock.calls[0][0] as Filters;
    expect(next.scopes.has('dev')).toBe(false);
    expect(next.scopes.has('prod')).toBe(true);
  });

  it('reports the state of each chip through aria-pressed', () => {
    renderToolbar({ filters: { ...ALL, onlyOutdated: true } });

    expect(screen.getByRole('button', { name: 'outdated' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'vulnerable' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('separates the two chip families, which pull in opposite directions', () => {
    renderToolbar();

    // Named by their legends, so the grouping is available to a screen reader
    // and not only to the eye.
    expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Show only' }),
    ).toBeInTheDocument();

    // And each chip lands in the group it belongs to.
    const scope = screen.getByRole('group', { name: 'Scope' });
    expect(within(scope).getByRole('button', { name: 'dev' })).toBeVisible();
    expect(
      within(scope).queryByRole('button', { name: 'outdated' }),
    ).toBeNull();
  });
});

describe('the summary line', () => {
  it('mentions a count only when it is non-zero', () => {
    const { rerender, props } = renderToolbar();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('12 packages');
    expect(status).toHaveTextContent('3 outdated');

    rerender(
      <Toolbar
        {...props}
        summary={{ ...SUMMARY, outdated: 0, vulnerable: 0, deprecated: 0 }}
      />,
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('outdated');
  });

  it('says when the data came from cache', () => {
    renderToolbar({ summary: { ...SUMMARY, stale: true } });
    expect(screen.getByRole('status')).toHaveTextContent('cached');
  });
});

describe('actions', () => {
  it('distinguishes re-reading from disk from querying registries', async () => {
    const onRefresh = vi.fn();
    const onCheckUpdates = vi.fn();
    renderToolbar({ onRefresh, onCheckUpdates });

    await userEvent.click(
      screen.getByRole('button', { name: /Check updates/i }),
    );
    expect(onCheckUpdates).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^Refresh/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('disables the scan actions while one is running', () => {
    renderToolbar({ busy: true });
    expect(
      screen.getByRole('button', { name: /Check updates/i }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Refresh/i })).toBeDisabled();
  });

  it('exposes the search panel toggle as an expander', () => {
    const { rerender, props } = renderToolbar();
    const toggle = screen.getByRole('button', { name: /Add package/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'panorama-search-panel');

    rerender(<Toolbar {...props} installOpen={true} />);
    expect(
      screen.getByRole('button', { name: /Close search/i }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('announces progress as a progressbar rather than a bare div', () => {
    renderToolbar({ busy: true, busyLabel: 'Checking registries…' });
    // The label names the progressbar rather than joining the summary's live
    // region, so progress is announced once and as progress.
    expect(screen.getByRole('progressbar')).toHaveAccessibleName(
      'Checking registries…',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'Checking registries',
    );
  });

  it('keeps the busy label visible even though it is not announced twice', () => {
    renderToolbar({ busy: true, busyLabel: 'Checking registries…' });
    expect(screen.getByText('Checking registries…')).toBeInTheDocument();
  });
});

describe('keyboard navigation', () => {
  /** Every button the roving tabindex covers, in DOM order. */
  const toolbarButtons = () =>
    [
      ...screen.getByRole('toolbar').querySelectorAll('button'),
    ] as HTMLElement[];

  it('moves between controls with arrow keys, as role=toolbar implies', async () => {
    // A toolbar is one tab stop; arrows move within it. Declaring the role
    // without implementing that leaves a promise the widget does not keep.
    renderToolbar();

    const chips = screen.getAllByRole('button', { name: /prod|dev|build/ });
    // Focusing a toolbar button moves the tab stop, which is a state update.
    await act(async () => chips[0].focus());
    expect(document.activeElement).toBe(chips[0]);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chips[1]);

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(chips[0]);
  });

  it('is a single tab stop — the other half of the same promise', () => {
    renderToolbar();

    const tabbable = toolbarButtons().filter((button) => button.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(toolbarButtons().length).toBeGreaterThan(1);
  });

  it('moves the tab stop along with the arrow keys', async () => {
    renderToolbar();

    const buttons = toolbarButtons();
    await act(async () => buttons[0].focus());
    await userEvent.keyboard('{ArrowRight}');

    expect(toolbarButtons().filter((b) => b.tabIndex === 0)).toEqual([
      buttons[1],
    ]);
    expect(buttons[0].tabIndex).toBe(-1);
  });

  it('adopts a button that is focused directly, so re-entry returns there', async () => {
    renderToolbar();

    const refresh = screen.getByRole('button', { name: /^Refresh/i });
    // Wrapped so the render the focus handler schedules has flushed before the
    // assertion reads tabIndex back out of the DOM.
    await act(async () => refresh.focus());

    expect(refresh.tabIndex).toBe(0);
    expect(toolbarButtons().filter((b) => b.tabIndex === 0)).toEqual([refresh]);
  });
});
