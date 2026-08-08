/**
 * The dependency table.
 *
 * Rows are virtualized: a large monorepo can easily declare a couple of
 * thousand dependencies, and rendering them all would make sorting and
 * filtering feel sluggish.
 *
 * Virtualization is also why keyboard support is a roving tabindex over the
 * whole row list rather than a tab stop per row: a row scrolled out of view is
 * not in the DOM, so no amount of `tabIndex` would let Tab reach it.
 * `aria-rowcount`/`aria-rowindex` tell assistive technology the true size of the
 * list even though only a window of it exists.
 *
 * This is also the one file where `useSemanticElements` and
 * `useFocusableInteractive` are switched off (see `biome.json`). Both rules ask
 * for something a virtualized grid cannot give: rows are absolutely positioned
 * at computed offsets, which a real `<table>` cannot express, and only the row
 * holding the roving tabindex is focusable — making every gridcell a tab stop
 * would be the accessibility regression, not the fix. Everywhere else in the
 * webview those rules are enforced.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import type { FocusEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dependency, Ecosystem, ProjectGroup } from '../core/types.js';
import { compareVersions } from '../core/versions/index.js';
import {
  currentVersion,
  hasUpdate,
  SCOPE_LABELS,
  statusRank,
} from '../core/vocabulary.js';
import {
  formatBytes,
  GROUP_HEADER_HEIGHT,
  ROW_HEIGHT,
  updateClass,
} from './format.js';

export type SortKey =
  | 'name'
  | 'scope'
  | 'current'
  | 'latest'
  | 'size'
  | 'status';
export interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

interface Props {
  groups: ProjectGroup[];
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  selectedKey: string | undefined;
  onSelect: (dep: Dependency) => void;
  onUpdate: (dep: Dependency) => void;
  onUninstall: (dep: Dependency) => void;
  onUpdateAll: (manifestPath: string) => void;
  onToggleMute: (dep: Dependency) => void;
  /** Set when a command asked to scroll a specific row into view. */
  scrollToKey?: string;
  /** Called once that scroll has happened, so the request is not repeated. */
  onScrollHandled?: () => void;
  /** True while the first scan is still running and there is nothing to show. */
  loading: boolean;
  /** True when a filter is narrowing the list — changes the empty state. */
  filtering: boolean;
  onClearFilters: () => void;
}

/** A flat render list so one virtualizer can cover group headers and rows. */
type Row =
  | { kind: 'group'; group: ProjectGroup; outdated: number }
  | { kind: 'dep'; dep: Dependency };

const COLUMNS: Array<{ key: SortKey | null; label: string; cell: string }> = [
  { key: 'name', label: 'Package', cell: 'cell--name' },
  { key: 'scope', label: 'Scope', cell: 'cell--scope' },
  { key: 'current', label: 'Current', cell: 'cell--version' },
  { key: 'latest', label: 'Latest', cell: 'cell--latest' },
  { key: 'size', label: 'Size', cell: 'cell--size' },
  { key: null, label: 'License', cell: 'cell--license' },
  { key: 'status', label: 'Status', cell: 'cell--status' },
  { key: null, label: 'Actions', cell: 'cell--actions' },
];

export function DepTable({
  groups,
  sort,
  onSortChange,
  selectedKey,
  onSelect,
  onUpdate,
  onUninstall,
  onUpdateAll,
  onToggleMute,
  scrollToKey,
  onScrollHandled,
  loading,
  filtering,
  onClearFilters,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    // Group headers only earn their space when there is more than one project.
    const showHeaders = groups.length > 1;

    for (const group of groups) {
      const sorted = sortDependencies(group.dependencies, sort);
      if (sorted.length === 0) continue;

      if (showHeaders) {
        result.push({
          kind: 'group',
          group,
          outdated: sorted.filter(hasUpdate).length,
        });
      }
      for (const dep of sorted) {
        result.push({ kind: 'dep', dep });
      }
    }
    return result;
  }, [groups, sort]);

  // Read from effects that must not re-run when the list is merely rebuilt.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      rows[index].kind === 'group' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT,
    overscan: 12,
  });

  /*
   * A virtualized row that is scrolled out of view is not in the DOM, so a
   * command targeting it has to move the viewport rather than call focus().
   *
   * `rows` is deliberately not a dependency: it is a fresh array on every scan,
   * and re-running this would drag the viewport back to a row the user has
   * since scrolled away from. The request is cleared once honoured.
   */
  useEffect(() => {
    if (!scrollToKey) return;
    const index = rowsRef.current.findIndex(
      (row) => row.kind === 'dep' && row.dep.key === scrollToKey,
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'center' });
      setFocusedIndex(index);
    }
    onScrollHandled?.();
  }, [scrollToKey, virtualizer, onScrollHandled]);

  const virtualItems = virtualizer.getVirtualItems();

  // Move DOM focus onto the row the roving tabindex points at, once the
  // virtualizer has actually rendered it.
  const shouldFocusRef = useRef(false);
  /*
   * `virtualItems` is in the dependency list on purpose: the row we want to
   * focus may not be mounted yet, so this has to run again each time the
   * virtualizer renders a new window.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!shouldFocusRef.current || focusedIndex < 0) return;
    const element = parentRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${focusedIndex}"]`,
    );
    if (element) {
      element.focus();
      shouldFocusRef.current = false;
    }
  }, [focusedIndex, virtualItems]);

  const moveFocus = useCallback(
    (from: number, step: number) => {
      const list = rowsRef.current;
      let next = from + step;
      // Group headers are labels, not stops.
      while (next >= 0 && next < list.length && list[next].kind !== 'dep') {
        next += step;
      }
      if (next < 0 || next >= list.length) return;
      shouldFocusRef.current = true;
      setFocusedIndex(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    },
    [virtualizer],
  );

  const edgeDepIndex = useCallback((fromEnd: boolean) => {
    const list = rowsRef.current;
    if (fromEnd) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].kind === 'dep') return i;
      }
      return -1;
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'dep') return i;
    }
    return -1;
  }, []);

  const jumpTo = useCallback(
    (index: number, align: 'start' | 'end') => {
      if (index < 0) return;
      shouldFocusRef.current = true;
      setFocusedIndex(index);
      virtualizer.scrollToIndex(index, { align });
    },
    [virtualizer],
  );

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(focusedIndex, 1);
        break;
      case 'ArrowUp':
        if (focusedIndex >= 0) {
          event.preventDefault();
          moveFocus(focusedIndex, -1);
        }
        break;
      case 'Home':
        event.preventDefault();
        jumpTo(edgeDepIndex(false), 'start');
        break;
      case 'End':
        event.preventDefault();
        jumpTo(edgeDepIndex(true), 'end');
        break;
    }
  };

  // Entering the grid with Tab lands on the first row rather than nowhere.
  const handleGridFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const index = focusedIndex >= 0 ? focusedIndex : edgeDepIndex(false);
    if (index < 0) return;
    shouldFocusRef.current = true;
    setFocusedIndex(index);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  const toggleSort = (key: SortKey) => {
    onSortChange(
      sort.key === key
        ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  const indicator = (key: SortKey) =>
    sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : '';

  const ariaSort = (
    key: SortKey | null,
  ): 'none' | 'ascending' | 'descending' | undefined => {
    if (!key) return undefined;
    if (sort.key !== key) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  };

  if (loading) {
    return (
      <div className="empty" role="status">
        <h2>Reading your manifests…</h2>
        <p>Panorama is scanning the workspace for dependency files.</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return filtering ? (
      <div className="empty">
        <h2>No dependencies match your filters</h2>
        <p>Clear the search box and re-enable the scopes to see everything.</p>
        <button
          type="button"
          className="empty__action secondary"
          onClick={onClearFilters}
        >
          Clear filters
        </button>
      </div>
    ) : (
      <div className="empty">
        <h2>No dependencies declared</h2>
        <p>The manifests in this workspace do not declare any dependencies.</p>
      </div>
    );
  }

  // The grid is one row taller than the data: the header counts as row 1.
  const focusedRendered = virtualItems.some(
    (item) => item.index === focusedIndex,
  );

  return (
    <div
      className="table__grid"
      role="grid"
      aria-label="Dependencies"
      aria-rowcount={rows.length + 1}
    >
      <div className="table__header" role="row" aria-rowindex={1}>
        {COLUMNS.map((column) => (
          <div
            key={column.label}
            className={`cell ${column.cell}`}
            role="columnheader"
            aria-sort={ariaSort(column.key)}
          >
            {column.key ? (
              <button
                type="button"
                onClick={() => toggleSort(column.key as SortKey)}
              >
                {column.label}
                {indicator(column.key)}
              </button>
            ) : (
              <span className="table__header-label">{column.label}</span>
            )}
          </div>
        ))}
      </div>

      <div
        className="table"
        ref={parentRef}
        role="rowgroup"
        tabIndex={focusedRendered ? -1 : 0}
        onKeyDown={handleGridKeyDown}
        onFocus={handleGridFocus}
      >
        <div
          role="presentation"
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                // Presentational: a grid must own its rows directly, and this
                // element exists only to position one.
                role="presentation"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.kind === 'group' ? (
                  <GroupHeader
                    row={row}
                    rowIndex={virtualRow.index + 2}
                    onUpdateAll={onUpdateAll}
                  />
                ) : (
                  <DepRow
                    dep={row.dep}
                    index={virtualRow.index}
                    rowIndex={virtualRow.index + 2}
                    tabbable={virtualRow.index === focusedIndex}
                    selected={row.dep.key === selectedKey}
                    onSelect={onSelect}
                    onUpdate={onUpdate}
                    onUninstall={onUninstall}
                    onToggleMute={onToggleMute}
                    onFocusRow={setFocusedIndex}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GroupHeader({
  row,
  rowIndex,
  onUpdateAll,
}: {
  row: Extract<Row, { kind: 'group' }>;
  rowIndex: number;
  onUpdateAll: (manifestPath: string) => void;
}) {
  return (
    <div className="table__group" role="row" aria-rowindex={rowIndex}>
      <div className="table__group-cell" role="gridcell">
        <span>{row.group.label}</span>
        {row.group.isWorkspaceRoot && (
          <span
            className="badge badge--workspace"
            title="Declares workspace members"
          >
            workspace root
          </span>
        )}
        {row.group.workspaceRootLabel && (
          <span
            className="badge badge--workspace"
            title={`A workspace member of ${row.group.workspaceRootLabel}`}
          >
            in {row.group.workspaceRootLabel}
          </span>
        )}
        <span className="table__group-meta">
          {row.group.toolchain} · {row.group.dependencies.length} packages
          {row.outdated > 0 ? ` · ${row.outdated} outdated` : ''}
        </span>
        <div className="table__group-spacer" />
        {row.outdated > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => onUpdateAll(row.group.manifestPath)}
          >
            Update all
          </button>
        )}
      </div>
    </div>
  );
}

/** The plain-language status, so meaning never rests on colour alone. */
function statusLabel(dep: Dependency): { text: string; className: string } {
  if (dep.vulnerabilities.length > 0) {
    return { text: 'Vulnerable', className: 'severity--vuln' };
  }
  if (dep.meta?.deprecated) {
    return { text: 'Deprecated', className: 'severity--deprecated' };
  }
  switch (dep.updateKind) {
    case 'major':
      return { text: 'Major', className: 'update--major' };
    case 'minor':
      return { text: 'Minor', className: 'update--minor' };
    case 'patch':
      return { text: 'Patch', className: 'update--patch' };
    case 'unknown':
      return { text: 'Unknown', className: 'update--none' };
    default:
      return { text: 'Current', className: 'update--none' };
  }
}

function DepRow({
  dep,
  index,
  rowIndex,
  tabbable,
  selected,
  onSelect,
  onUpdate,
  onUninstall,
  onToggleMute,
  onFocusRow,
}: {
  dep: Dependency;
  index: number;
  rowIndex: number;
  tabbable: boolean;
  selected: boolean;
  onSelect: (dep: Dependency) => void;
  onUpdate: (dep: Dependency) => void;
  onUninstall: (dep: Dependency) => void;
  onToggleMute: (dep: Dependency) => void;
  onFocusRow: (index: number) => void;
}) {
  const upgradeable = hasUpdate(dep);
  const status = statusLabel(dep);

  return (
    <div
      className={dep.muted ? 'row row--muted' : 'row'}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      data-row-index={index}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => onFocusRow(index)}
      onClick={() => onSelect(dep)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(dep);
        }
      }}
    >
      <div className="cell cell--name" role="gridcell" title={dep.name}>
        {dep.vulnerabilities.length > 0 && (
          <span
            className="severity--vuln"
            role="img"
            title={`${dep.vulnerabilities.length} known vulnerability(ies)`}
            aria-label="Vulnerable"
          >
            ⬤
          </span>
        )}
        {dep.meta?.deprecated && (
          <span
            className="severity--deprecated"
            role="img"
            title={dep.meta.deprecated}
            aria-label="Deprecated"
          >
            ▲
          </span>
        )}
        <span data-package-name>{dep.name}</span>
        {dep.muted && (
          <span
            className="badge badge--muted"
            title="Updates muted — not counted as outdated"
          >
            muted
          </span>
        )}
      </div>

      <div className="cell cell--scope" role="gridcell">
        <span className={`badge badge--${dep.scope}`}>
          {SCOPE_LABELS[dep.scope].short}
        </span>
      </div>

      <div
        className="cell cell--version"
        role="gridcell"
        title={`Declared as ${dep.declared}`}
      >
        {currentVersion(dep)}
      </div>

      <div
        className={`cell cell--latest ${updateClass(dep.updateKind)}`}
        role="gridcell"
      >
        {dep.lookupFailed ? (
          <span className="muted" title="Registry lookup failed">
            —
          </span>
        ) : (
          (dep.latest ?? '—')
        )}
      </div>

      <div className="cell cell--size" role="gridcell">
        {formatBytes(dep.meta?.sizeBytes)}
      </div>
      <div className="cell cell--license" role="gridcell">
        {dep.meta?.license ?? '—'}
      </div>
      <div className={`cell cell--status ${status.className}`} role="gridcell">
        {status.text}
      </div>

      {/*
       * Every action carries an aria-label naming its package. The visible text
       * has to stay short to fit the column, but a screen-reader user moving
       * through a few hundred rows would otherwise hear "Update, Mute, Remove"
       * repeated with nothing to tell one row from the next. `title` cannot do
       * this job — it supplies a description, not an accessible name.
       */}
      <div className="cell cell--actions" role="gridcell">
        {upgradeable && dep.latest && (
          <>
            <button
              type="button"
              className="ghost"
              aria-label={`Update ${dep.name} to ${dep.latest}`}
              title={`Update to ${dep.latest}`}
              onClick={(event) => {
                event.stopPropagation();
                onUpdate(dep);
              }}
            >
              Update
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={
                dep.muted
                  ? `Unmute ${dep.name}`
                  : `Mute update notifications for ${dep.name}`
              }
              title={
                dep.muted
                  ? `Unmute ${dep.name} so it counts as outdated again`
                  : `Mute ${dep.name} — keeps it listed but out of the outdated count`
              }
              aria-pressed={dep.muted ?? false}
              onClick={(event) => {
                event.stopPropagation();
                onToggleMute(dep);
              }}
            >
              {dep.muted ? 'Unmute' : 'Mute'}
            </button>
          </>
        )}
        <button
          type="button"
          className="ghost danger"
          aria-label={`Remove ${dep.name} from this project`}
          title={`Remove ${dep.name} from this project`}
          onClick={(event) => {
            event.stopPropagation();
            onUninstall(dep);
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * Orders two version cells using their own ecosystem's rules.
 *
 * Collation with `numeric: true` gets simple cases right and the interesting
 * ones wrong: it ranks `1.0.0-rc1` above `1.0.0`, and it has no idea that Maven
 * sorts `1.0-SNAPSHOT` below `1.0`. Deferring to `core/versions` is also what
 * keeps the table's ordering consistent with the "is this outdated" judgement
 * made from exactly those comparators.
 *
 * Rows from two different ecosystems only meet when the table shows several
 * projects at once; there is no shared ordering to appeal to, so those fall
 * back to a plain string comparison.
 */
function compareVersionCells(
  ecosystemA: Ecosystem,
  a: string | undefined,
  ecosystemB: Ecosystem,
  b: string | undefined,
): number {
  // Missing versions sort last in ascending order.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  if (ecosystemA !== ecosystemB) {
    return a.localeCompare(b, undefined, { numeric: true });
  }
  return compareVersions(ecosystemA, a, b);
}

function sortDependencies(
  dependencies: Dependency[],
  sort: SortState,
): Dependency[] {
  const factor = sort.direction === 'asc' ? 1 : -1;

  return [...dependencies].sort((a, b) => {
    let comparison = 0;
    switch (sort.key) {
      case 'name':
        comparison = a.name.localeCompare(b.name);
        break;
      case 'scope':
        comparison =
          a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name);
        break;
      case 'current':
        comparison = compareVersionCells(
          a.ecosystem,
          currentVersion(a),
          b.ecosystem,
          currentVersion(b),
        );
        break;
      case 'latest':
        comparison = compareVersionCells(
          a.ecosystem,
          a.latest,
          b.ecosystem,
          b.latest,
        );
        break;
      case 'size':
        comparison = (a.meta?.sizeBytes ?? -1) - (b.meta?.sizeBytes ?? -1);
        break;
      case 'status':
        comparison =
          statusRank(a) - statusRank(b) || a.name.localeCompare(b.name);
        break;
    }
    return comparison * factor;
  });
}
