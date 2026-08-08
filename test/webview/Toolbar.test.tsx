/**
 * The toolbar: filters, the summary line, and its keyboard contract.
 */

import { render, screen } from '@testing-library/react';
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
  hideMuted: false,
};

const SUMMARY: ScanSummary = {
  totalDependencies: 12,
  outdated: 3,
  vulnerable: 1,
  deprecated: 2,
  muted: 0,
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

  it('offers "hide muted" only once something is muted', () => {
    const { rerender, props } = renderToolbar();
    expect(screen.queryByRole('button', { name: /hide muted/i })).toBeNull();

    rerender(<Toolbar {...props} summary={{ ...SUMMARY, muted: 2 }} />);
    expect(
      screen.getByRole('button', { name: /hide muted/i }),
    ).toBeInTheDocument();
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
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking registries');
  });
});

describe('keyboard navigation', () => {
  it('moves between controls with arrow keys, as role=toolbar implies', async () => {
    // A toolbar is one tab stop; arrows move within it. Declaring the role
    // without implementing that leaves a promise the widget does not keep.
    renderToolbar();

    const chips = screen.getAllByRole('button', { name: /prod|dev|build/ });
    chips[0].focus();
    expect(document.activeElement).toBe(chips[0]);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chips[1]);

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(chips[0]);
  });
});
