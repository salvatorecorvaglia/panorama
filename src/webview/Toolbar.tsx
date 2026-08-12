import type { FocusEvent, KeyboardEvent, Ref } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DepScope, ProjectGroup, ScanSummary } from '../core/types.js';
import { ALL_SCOPES, SCOPE_LABELS } from '../core/vocabulary.js';
import { Icon } from './Icon.js';

export interface Filters {
  text: string;
  scopes: Set<DepScope>;
  onlyOutdated: boolean;
  onlyVulnerable: boolean;
  onlyDeprecated: boolean;
}

interface Props {
  groups?: ProjectGroup[];
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  summary: ScanSummary;
  busy: boolean;
  busyLabel: string | undefined;
  onRefresh: () => void;
  onCheckUpdates: () => void;
  onUpdateAll?: (manifestPath?: string) => void;
  onToggleInstall: () => void;
  installOpen: boolean;
  /** Lets the app put the caret here from a keyboard shortcut. */
  filterRef?: Ref<HTMLInputElement>;
}

export function Toolbar({
  groups = [],
  filters,
  onFiltersChange,
  summary,
  busy,
  busyLabel,
  onRefresh,
  onCheckUpdates,
  onUpdateAll,
  onToggleInstall,
  installOpen,
  filterRef,
}: Props) {
  const toggleScope = (scope: DepScope) => {
    const scopes = new Set(filters.scopes);
    if (scopes.has(scope)) {
      scopes.delete(scope);
    } else {
      scopes.add(scope);
    }
    onFiltersChange({ ...filters, scopes });
  };

  const container = useRef<HTMLDivElement>(null);
  /** Which button currently holds the toolbar's single tab stop. */
  const [activeIndex, setActiveIndex] = useState(0);

  const toolbarButtons = useCallback(
    (): HTMLElement[] => [
      ...(container.current?.querySelectorAll<HTMLElement>('button') ?? []),
    ],
    [],
  );

  useEffect(() => {
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    const active = Math.min(activeIndex, buttons.length - 1);
    buttons.forEach((button, index) => {
      button.tabIndex = index === active ? 0 : -1;
    });
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;

    const focusable = toolbarButtons();
    const index = focusable.indexOf(target);
    if (index < 0) return;

    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + step + focusable.length) % focusable.length;
    setActiveIndex(next);
    focusable[next]?.focus();
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = toolbarButtons().indexOf(event.target as HTMLElement);
    if (index >= 0) setActiveIndex(index);
  };

  const activeToolchains = useMemo(() => {
    if (!groups || groups.length === 0) return [];
    const set = new Set<string>();
    for (const g of groups) {
      if (g.toolchain) set.add(g.toolchain.toUpperCase());
    }
    return Array.from(set);
  }, [groups]);

  const handleGlobalUpdateAll = () => {
    if (onUpdateAll && groups.length > 0) {
      onUpdateAll(groups[0].manifestPath);
    }
  };

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Panorama actions"
      ref={container}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
    >
      {/* Top Header & Environment Bar */}
      <div className="toolbar__header-bar">
        <div className="toolbar__branding">
          <div className="toolbar__logo-icon">
            <Icon name="package" />
          </div>
          <div className="toolbar__title-group">
            <span className="toolbar__title">Panorama Visual Manager</span>
            <div className="toolbar__env-pills">
              <span className="env-pill env-pill--status">
                <span className="env-pill__dot" /> active
              </span>
              {activeToolchains.map((tc) => (
                <span key={tc} className="env-pill env-pill--toolchain">
                  {tc}
                </span>
              ))}
              <span className="env-pill env-pill--count">
                {summary.totalDependencies} packages
              </span>
            </div>
          </div>
        </div>

        <div className="toolbar__header-actions">
          {summary.outdated > 0 && (
            <button
              type="button"
              className="btn-update-all-primary"
              onClick={handleGlobalUpdateAll}
              disabled={busy}
            >
              Update All ({summary.outdated})
            </button>
          )}
        </div>
      </div>

      {/* Main Control & Search Row */}
      <div className="toolbar__row">
        <div className="toolbar__search">
          <input
            ref={filterRef}
            type="search"
            placeholder="Filter installed packages…"
            value={filters.text}
            aria-label="Filter installed packages"
            onChange={(event) =>
              onFiltersChange({ ...filters, text: event.target.value })
            }
          />
        </div>

        <button
          type="button"
          className="btn-accent"
          onClick={onToggleInstall}
          aria-expanded={installOpen}
          aria-controls="panorama-search-panel"
        >
          {installOpen ? 'Close search' : '+ Add package'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onCheckUpdates}
          disabled={busy}
          title="Query the registries now for newer versions, even if automatic checks are off"
        >
          Check updates
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onRefresh}
          disabled={busy}
          title="Re-read the manifests and lockfiles from disk"
        >
          Refresh
        </button>
      </div>

      {/* Filter Chips & Summary Row */}
      <div className="toolbar__row">
        <fieldset className="toolbar__group">
          <legend className="toolbar__legend">Scope</legend>
          <div className="toolbar__chips">
            {ALL_SCOPES.map((scope) => (
              <button
                type="button"
                key={scope}
                className="chip"
                aria-pressed={filters.scopes.has(scope)}
                onClick={() => toggleScope(scope)}
              >
                {SCOPE_LABELS[scope].short}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="toolbar__group toolbar__group--divided">
          <legend className="toolbar__legend">Show only</legend>
          <div className="toolbar__chips">
            <button
              type="button"
              className="chip"
              aria-pressed={filters.onlyOutdated}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  onlyOutdated: !filters.onlyOutdated,
                })
              }
            >
              outdated
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={filters.onlyVulnerable}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  onlyVulnerable: !filters.onlyVulnerable,
                })
              }
            >
              vulnerable
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={filters.onlyDeprecated}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  onlyDeprecated: !filters.onlyDeprecated,
                })
              }
            >
              deprecated
            </button>
          </div>
        </fieldset>

        <div className="toolbar__spacer" />

        {busy && busyLabel && (
          <span className="muted" aria-hidden="true">
            {busyLabel}
          </span>
        )}

        <div className="toolbar__summary" role="status">
          <span>{summary.totalDependencies} packages</span>
          {summary.outdated > 0 && (
            <span className="highlight-outdated">
              {summary.outdated} outdated
            </span>
          )}
          {summary.vulnerable > 0 && (
            <span className="severity--vuln">
              {summary.vulnerable} vulnerable
            </span>
          )}
          {summary.deprecated > 0 && (
            <span className="severity--deprecated">
              {summary.deprecated} deprecated
            </span>
          )}
          {summary.stale && (
            <span title="Registries were unreachable">cached</span>
          )}
        </div>
      </div>

      {busy && (
        <div
          className="progress"
          role="progressbar"
          aria-label={busyLabel ?? 'Scanning'}
        />
      )}
    </div>
  );
}
