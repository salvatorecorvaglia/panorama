/**
 * The dependency table: sorting, the ARIA grid contract, and the per-row
 * actions.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  Dependency,
  ProjectGroup,
  Vulnerability,
} from '../../src/core/types.js';
import { DepTable, type SortState } from '../../src/webview/DepTable.js';

function dep(overrides: Partial<Dependency> = {}): Dependency {
  return {
    key: overrides.name ?? 'k',
    name: 'pkg',
    ecosystem: 'node',
    scope: 'prod',
    declared: '^1.0.0',
    installed: '1.0.0',
    updateKind: 'none',
    vulnerabilities: [],
    manifestPath: '/p/package.json',
    projectLabel: 'app',
    ...overrides,
  };
}

function vuln(overrides: Partial<Vulnerability> = {}): Vulnerability {
  return {
    id: 'GHSA-1',
    summary: 's',
    severity: 'high',
    aliases: [],
    url: 'https://osv.dev/x',
    ...overrides,
  };
}

function group(dependencies: Dependency[]): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies,
  };
}

const noop = () => {};

function renderTable(
  groups: ProjectGroup[],
  sort: SortState = { key: 'name', direction: 'asc' },
  overrides: Partial<Parameters<typeof DepTable>[0]> = {},
) {
  return render(
    <DepTable
      groups={groups}
      sort={sort}
      onSortChange={noop}
      selectedKey={undefined}
      onSelect={noop}
      onUpdate={noop}
      onUninstall={noop}
      onUpdateAll={noop}
      loading={false}
      filtering={false}
      onClearFilters={noop}
      {...overrides}
    />,
  );
}

/**
 * Row names in render order.
 *
 * Read from the row's accessible name rather than the name cell's text, which
 * also carries the vulnerability and deprecation glyphs.
 */
function renderedNames(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1) // the header
    .map(
      (row) =>
        within(row)
          .getAllByRole('gridcell')[0]
          .querySelector('[data-package-name]')?.textContent ?? '',
    );
}

describe('sorting', () => {
  it('orders versions by the ecosystem scheme, not lexically', () => {
    // Collation would put 1.10.0 before 1.9.0 only by luck, and would rank a
    // release candidate above its own release.
    renderTable(
      [
        group([
          dep({ name: 'a', key: 'a', latest: '1.9.0' }),
          dep({ name: 'b', key: 'b', latest: '1.10.0' }),
          dep({ name: 'c', key: 'c', latest: '1.10.0-rc1' }),
        ]),
      ],
      { key: 'latest', direction: 'asc' },
    );

    expect(renderedNames()).toEqual(['a', 'c', 'b']);
  });

  it('respects Maven ordering, where SNAPSHOT precedes its release', () => {
    renderTable(
      [
        {
          ...group([
            dep({
              name: 'x',
              key: 'x',
              ecosystem: 'maven',
              latest: '1.0',
            }),
            dep({
              name: 'y',
              key: 'y',
              ecosystem: 'maven',
              latest: '1.0-SNAPSHOT',
            }),
          ]),
          ecosystem: 'maven',
        },
      ],
      { key: 'latest', direction: 'asc' },
    );

    expect(renderedNames()).toEqual(['y', 'x']);
  });

  it('sorts missing versions last regardless of direction', () => {
    renderTable(
      [
        group([
          dep({ name: 'a', key: 'a', latest: undefined }),
          dep({ name: 'b', key: 'b', latest: '1.0.0' }),
        ]),
      ],
      { key: 'latest', direction: 'asc' },
    );

    expect(renderedNames()).toEqual(['b', 'a']);
  });

  it('reverses on a descending sort', () => {
    renderTable(
      [
        group([
          dep({ name: 'a', key: 'a' }),
          dep({ name: 'b', key: 'b' }),
          dep({ name: 'c', key: 'c' }),
        ]),
      ],
      { key: 'name', direction: 'desc' },
    );

    expect(renderedNames()).toEqual(['c', 'b', 'a']);
  });

  it('ranks problems above merely outdated packages', () => {
    renderTable(
      [
        group([
          dep({ name: 'current', key: '1', updateKind: 'none' }),
          dep({ name: 'patch', key: '2', updateKind: 'patch' }),
          dep({
            name: 'vulnerable',
            key: '3',
            updateKind: 'none',
            vulnerabilities: [vuln()],
          }),
          dep({
            name: 'deprecated',
            key: '4',
            meta: { name: 'deprecated', deprecated: 'gone' },
          }),
        ]),
      ],
      { key: 'status', direction: 'asc' },
    );

    expect(renderedNames()).toEqual([
      'vulnerable',
      'deprecated',
      'patch',
      'current',
    ]);
  });
});

describe('the ARIA grid contract', () => {
  it('keeps rows inside the grid', () => {
    /*
     * A regression guard, not a conformance check: testing-library resolves
     * roles by attribute and does not enforce ARIA's required-owned-element
     * rules, so it would not notice the positioning wrappers on its own. Real
     * assistive technology does, which is why those wrappers carry
     * role="presentation" — asserted separately below.
     */
    renderTable([group([dep({ name: 'react', key: 'react' })])]);

    const grid = screen.getByRole('grid');
    expect(within(grid).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('marks the virtualizer’s positioning wrappers as presentational', () => {
    // Without this the grid owns two levels of generic div before reaching a
    // row, which breaks the grid/row relationship for screen readers.
    const { container } = renderTable([
      group([dep({ name: 'react', key: 'react' })]),
    ]);

    const row = container.querySelector('[data-row-index]');
    expect(row).not.toBeNull();

    // Every element between the row and the rowgroup must be presentational.
    let node = row?.parentElement;
    const rowgroup = container.querySelector('[role="rowgroup"]');
    while (node && node !== rowgroup) {
      expect(node).toHaveAttribute('role', 'presentation');
      node = node.parentElement;
    }
    expect(node).toBe(rowgroup);
  });

  it('reports the true row count even though only a window is mounted', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      dep({ name: `pkg${i}`, key: `k${i}` }),
    );
    renderTable([group(many)]);

    // 500 rows plus the header.
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '501');
    expect(screen.getAllByRole('row').length).toBeLessThan(501);
  });

  it('marks the sorted column and leaves the others as none', async () => {
    const onSortChange = vi.fn();
    renderTable(
      [group([dep()])],
      { key: 'name', direction: 'asc' },
      {
        onSortChange,
      },
    );

    expect(
      screen.getByRole('columnheader', { name: /Package/ }),
    ).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('columnheader', { name: /Scope/ })).toHaveAttribute(
      'aria-sort',
      'none',
    );

    await userEvent.click(screen.getByRole('button', { name: /Package/ }));
    expect(onSortChange).toHaveBeenCalledWith({
      key: 'name',
      direction: 'desc',
    });
  });

  it('leaves the sort direction to aria-sort rather than the button name', () => {
    // The direction used to be a text arrow inside the label, so the accessible
    // name read "Package ↑" — the same fact aria-sort already carries, in a
    // form nobody chose to hear.
    renderTable([group([dep()])], { key: 'name', direction: 'desc' });

    const header = screen.getByRole('columnheader', { name: /Package/ });
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(within(header).getByRole('button').textContent?.trim()).toBe(
      'Package',
    );
  });
});

describe('severity markers', () => {
  it('names the icons, which are the only signal in their cell', () => {
    // They are icons, not text: without a name a screen reader reaches a row
    // that looks identical to a healthy one.
    renderTable([
      group([
        dep({ name: 'vulnerable-pkg', key: 'v', vulnerabilities: [vuln()] }),
        dep({
          name: 'old-pkg',
          key: 'd',
          meta: { name: 'old-pkg', deprecated: 'Use something else' },
        }),
      ]),
    ]);

    expect(screen.getByRole('img', { name: 'Vulnerable' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Deprecated' })).toBeInTheDocument();
  });

  it('shows no marker on a healthy package', () => {
    renderTable([group([dep({ name: 'fine', key: 'f' })])]);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('row actions', () => {
  it('names each action with its package, so they are distinguishable', () => {
    // Twenty buttons all called "Remove" are unusable with a screen reader.
    renderTable([
      group([
        dep({
          name: 'react',
          key: 'react',
          updateKind: 'minor',
          latest: '2.0.0',
        }),
        dep({ name: 'lodash', key: 'lodash' }),
      ]),
    ]);

    expect(
      screen.getByRole('button', { name: /Remove react/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Remove lodash/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Update react to 2\.0\.0/i }),
    ).toBeInTheDocument();
  });

  it('offers update only where an update exists', () => {
    renderTable([
      group([dep({ name: 'current', key: 'c', updateKind: 'none' })]),
    ]);

    expect(screen.queryByRole('button', { name: /Update/i })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Remove current/i }),
    ).toBeInTheDocument();
  });

  it('does not select the row when an action is clicked', async () => {
    const onSelect = vi.fn();
    const onUninstall = vi.fn();
    renderTable([group([dep({ name: 'react', key: 'react' })])], undefined, {
      onSelect,
      onUninstall,
    });

    await userEvent.click(
      screen.getByRole('button', { name: /Remove react/i }),
    );

    expect(onUninstall).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('keyboard navigation', () => {
  /** `data-row-index` of the row currently holding real DOM focus, if any. */
  function focusedRowIndex(): string | null {
    return document.activeElement instanceof HTMLElement
      ? document.activeElement.getAttribute('data-row-index')
      : null;
  }

  it('enters the grid on the first row and moves down/up with the arrow keys', () => {
    renderTable([
      group([
        dep({ name: 'a', key: 'a' }),
        dep({ name: 'b', key: 'b' }),
        dep({ name: 'c', key: 'c' }),
      ]),
    ]);

    fireEvent.focus(screen.getByRole('rowgroup'));
    expect(focusedRowIndex()).toBe('0');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('2');

    // Already on the last row: nothing to move to.
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('2');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowUp',
    });
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowUp',
    });
    expect(focusedRowIndex()).toBe('0');

    // Already on the first row: nothing to move to.
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowUp',
    });
    expect(focusedRowIndex()).toBe('0');
  });

  it('jumps to the first and last row with Home and End', () => {
    renderTable([
      group(['a', 'b', 'c', 'd', 'e'].map((name) => dep({ name, key: name }))),
    ]);

    fireEvent.focus(screen.getByRole('rowgroup'));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(focusedRowIndex()).toBe('4');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(focusedRowIndex()).toBe('0');
  });

  it('skips group header rows rather than stopping on them', () => {
    // Two groups so headers render at all — a single group never shows one.
    renderTable([
      { ...group([dep({ name: 'a1', key: 'a1' })]), label: 'first' },
      {
        ...group([dep({ name: 'b1', key: 'b1' })]),
        label: 'second',
        manifestPath: '/p2/package.json',
      },
    ]);

    // Rows: [header:first, a1, header:second, b1] — indices 0-3.
    fireEvent.focus(screen.getByRole('rowgroup'));
    // Entering the grid lands on the first *dep* row, not the header.
    expect(focusedRowIndex()).toBe('1');

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
    });
    // Index 2 is the second group's header — skipped straight through to b1.
    expect(focusedRowIndex()).toBe('3');
  });
});

describe('empty and loading states', () => {
  it('distinguishes "nothing matches your filter" from "nothing declared"', () => {
    const onClearFilters = vi.fn();
    const { rerender } = renderTable([], undefined, {
      filtering: true,
      onClearFilters,
    });
    expect(screen.getByText(/No dependencies match/i)).toBeInTheDocument();

    rerender(
      <DepTable
        groups={[]}
        sort={{ key: 'name', direction: 'asc' }}
        onSortChange={noop}
        selectedKey={undefined}
        onSelect={noop}
        onUpdate={noop}
        onUninstall={noop}
        onUpdateAll={noop}
        loading={false}
        filtering={false}
        onClearFilters={onClearFilters}
      />,
    );
    expect(screen.getByText(/No dependencies declared/i)).toBeInTheDocument();
  });

  it('announces the first scan as a status rather than silently blank', () => {
    renderTable([], undefined, { loading: true });
    expect(screen.getByRole('status')).toHaveTextContent(
      /Reading your manifests/i,
    );
  });
});
