/**
 * The dependency table.
 *
 * Rows are virtualized: a large monorepo can easily declare a couple of
 * thousand dependencies, and rendering them all would make sorting and
 * filtering feel sluggish.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';
import type { Dependency, ProjectGroup } from '../core/types.js';
import {
  currentVersion,
  formatBytes,
  hasUpdate,
  SCOPE_LABELS,
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
}

/** A flat render list so one virtualizer can cover group headers and rows. */
type Row =
  | { kind: 'group'; group: ProjectGroup; outdated: number }
  | { kind: 'dep'; dep: Dependency };

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
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

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

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index].kind === 'group' ? 40 : 34),
    overscan: 12,
  });

  // A virtualized row that is scrolled out of view is not in the DOM, so a
  // command targeting it has to move the viewport rather than call focus().
  useEffect(() => {
    if (!scrollToKey) return;
    const index = rows.findIndex(
      (row) => row.kind === 'dep' && row.dep.key === scrollToKey,
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'center' });
    }
  }, [scrollToKey, rows, virtualizer]);

  const toggleSort = (key: SortKey) => {
    onSortChange(
      sort.key === key
        ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  const indicator = (key: SortKey) =>
    sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : '';

  if (rows.length === 0) {
    return (
      <div className="empty">
        <h2>No dependencies match your filters</h2>
        <p>Try clearing the search box or re-enabling a scope filter.</p>
      </div>
    );
  }

  return (
    <>
      <div className="table__header" role="row">
        <div className="cell cell--name">
          <button onClick={() => toggleSort('name')}>
            Package{indicator('name')}
          </button>
        </div>
        <div className="cell cell--scope">
          <button onClick={() => toggleSort('scope')}>
            Scope{indicator('scope')}
          </button>
        </div>
        <div className="cell cell--version">
          <button onClick={() => toggleSort('current')}>
            Current{indicator('current')}
          </button>
        </div>
        <div className="cell cell--latest">
          <button onClick={() => toggleSort('latest')}>
            Latest{indicator('latest')}
          </button>
        </div>
        <div className="cell cell--size">
          <button onClick={() => toggleSort('size')}>
            Size{indicator('size')}
          </button>
        </div>
        <div className="cell cell--license">License</div>
        <div className="cell cell--actions">
          <button onClick={() => toggleSort('status')}>
            Status{indicator('status')}
          </button>
        </div>
      </div>

      <div className="table" ref={parentRef}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
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
                  <GroupHeader row={row} onUpdateAll={onUpdateAll} />
                ) : (
                  <DepRow
                    dep={row.dep}
                    selected={row.dep.key === selectedKey}
                    onSelect={onSelect}
                    onUpdate={onUpdate}
                    onUninstall={onUninstall}
                    onToggleMute={onToggleMute}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function GroupHeader({
  row,
  onUpdateAll,
}: {
  row: Extract<Row, { kind: 'group' }>;
  onUpdateAll: (manifestPath: string) => void;
}) {
  return (
    <div className="table__group">
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
      <div style={{ flex: 1 }} />
      {row.outdated > 0 && (
        <button
          className="secondary"
          onClick={() => onUpdateAll(row.group.manifestPath)}
        >
          Update all
        </button>
      )}
    </div>
  );
}

function DepRow({
  dep,
  selected,
  onSelect,
  onUpdate,
  onUninstall,
  onToggleMute,
}: {
  dep: Dependency;
  selected: boolean;
  onSelect: (dep: Dependency) => void;
  onUpdate: (dep: Dependency) => void;
  onUninstall: (dep: Dependency) => void;
  onToggleMute: (dep: Dependency) => void;
}) {
  const upgradeable = hasUpdate(dep);

  return (
    <div
      className={dep.muted ? 'row row--muted' : 'row'}
      role="row"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(dep)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(dep);
        }
      }}
    >
      <div className="cell cell--name" title={dep.name}>
        {dep.vulnerabilities.length > 0 && (
          <span
            className="icon-vuln"
            role="img"
            title={`${dep.vulnerabilities.length} known vulnerability(ies)`}
            aria-label="Vulnerable"
          >
            ⬤
          </span>
        )}
        {dep.meta?.deprecated && (
          <span
            className="icon-warn"
            role="img"
            title={dep.meta.deprecated}
            aria-label="Deprecated"
          >
            ▲
          </span>
        )}
        <span>{dep.name}</span>
        {dep.muted && (
          <span
            className="badge badge--muted"
            title="Updates muted — not counted as outdated"
          >
            muted
          </span>
        )}
      </div>

      <div className="cell cell--scope">
        <span className={`badge badge--${dep.scope}`}>
          {SCOPE_LABELS[dep.scope]}
        </span>
      </div>

      <div className="cell cell--version" title={`Declared as ${dep.declared}`}>
        {currentVersion(dep)}
      </div>

      <div className={`cell cell--latest ${updateClass(dep.updateKind)}`}>
        {dep.lookupFailed ? (
          <span className="muted" title="Registry lookup failed">
            —
          </span>
        ) : (
          (dep.latest ?? '—')
        )}
      </div>

      <div className="cell cell--size">{formatBytes(dep.meta?.sizeBytes)}</div>
      <div className="cell cell--license">{dep.meta?.license ?? '—'}</div>

      <div className="cell cell--actions">
        {upgradeable && dep.latest && (
          <>
            <button
              className="ghost"
              title={`Update to ${dep.latest}`}
              onClick={(event) => {
                event.stopPropagation();
                onUpdate(dep);
              }}
            >
              Update
            </button>
            <button
              className="ghost"
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
          className="ghost"
          title={`Remove ${dep.name}`}
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

/** Problem severity is the tiebreaker everywhere, so it stays visible on top. */
function statusRank(dep: Dependency): number {
  if (dep.vulnerabilities.length > 0) return 0;
  if (dep.meta?.deprecated) return 1;
  if (dep.updateKind === 'major') return 2;
  if (dep.updateKind === 'minor') return 3;
  if (dep.updateKind === 'patch') return 4;
  return 5;
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
        comparison = currentVersion(a).localeCompare(
          currentVersion(b),
          undefined,
          {
            numeric: true,
          },
        );
        break;
      case 'latest':
        comparison = (a.latest ?? '').localeCompare(b.latest ?? '', undefined, {
          numeric: true,
        });
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
