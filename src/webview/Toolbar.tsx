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
  onToggleDuplicates?: () => void;
  duplicatesOpen?: boolean;
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
  onToggleDuplicates,
  duplicatesOpen = false,
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

  /*
   * A toolbar is one tab stop; arrow keys move within it.
   *
   * Assigning `tabIndex` imperatively rather than in JSX because the buttons
   * are conditional — "Update All" appears only when something is outdated —
   * so their count and order change, and the index that holds the stop has to
   * be clamped against whatever is on screen now. The dependency list is what
   * actually changes that: which buttons render is a function of these.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    const active = Math.min(activeIndex, buttons.length - 1);
    buttons.forEach((button, index) => {
      button.tabIndex = index === active ? 0 : -1;
    });
  }, [activeIndex, toolbarButtons, installOpen, summary.outdated, busy]);

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

  /*
   * The count next to this button is the whole workspace's, so the action has
   * to be the whole workspace's too. With one project that is unambiguous;
   * with several, naming none of them lets the host ask which — it used to
   * silently pass `groups[0]`, promising to update everything and updating
   * whichever project happened to sort first.
   */
  const handleGlobalUpdateAll = () => {
    if (!onUpdateAll || groups.length === 0) return;
    onUpdateAll(groups.length === 1 ? groups[0].manifestPath : undefined);
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
            <span className="toolbar__title">Panorama</span>
            {/*
              The toolchains in play, and nothing else. An "active" pill said
              only that the panel was rendering, and the package count is in
              the summary at the end of the filter row — two counts of the same
              thing in one toolbar invite the reader to look for the difference.
            */}
            <div className="toolbar__env-pills">
              {activeToolchains.map((tc) => (
                <span key={tc} className="env-pill env-pill--toolchain">
                  {tc}
                </span>
              ))}
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
          <Icon name={installOpen ? 'close' : 'add'} />{' '}
          {installOpen ? 'Close search' : 'Add package'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onCheckUpdates}
          disabled={busy}
          title="Query the registries now for newer versions, even if automatic checks are off"
        >
          <Icon name="cloud-download" /> Check updates
        </button>
        {onToggleDuplicates && (
          <button
            type="button"
            className="secondary"
            onClick={onToggleDuplicates}
            aria-expanded={duplicatesOpen}
            aria-controls="panorama-duplicates-panel"
            title="Find packages resolved at more than one version at once"
          >
            <Icon name="layers" /> Duplicate versions
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={onRefresh}
          disabled={busy}
          title="Re-read the manifests and lockfiles from disk"
        >
          <Icon name="refresh" /> Refresh
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
              <span className="chip__dot chip__dot--outdated" /> outdated
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
              <span className="chip__dot chip__dot--vuln" /> vulnerable
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
              <span className="chip__dot chip__dot--deprecated" /> deprecated
            </button>
          </div>
        </fieldset>

        <div className="toolbar__spacer" />

        {/*
          Readable, not hidden. This was `aria-hidden`, which left the only
          statement of *what* is happening ("Checking registries…") available
          to sighted users alone — the progress bar below announces that
          something is happening, not what.
        */}
        {busy && busyLabel && <span className="muted">{busyLabel}</span>}

        <div className="toolbar__summary" role="status">
          <span className="toolbar__kpi">
            <span className="kpi-dot kpi-dot--total" />{' '}
            {summary.totalDependencies} packages
          </span>
          {summary.outdated > 0 && (
            <span className="toolbar__kpi">
              <span className="kpi-dot kpi-dot--outdated" /> {summary.outdated}{' '}
              outdated
            </span>
          )}
          {summary.vulnerable > 0 && (
            <span className="toolbar__kpi">
              <span className="kpi-dot kpi-dot--vuln" /> {summary.vulnerable}{' '}
              vulnerable
            </span>
          )}
          {summary.deprecated > 0 && (
            <span className="toolbar__kpi">
              <span className="kpi-dot kpi-dot--deprecated" />{' '}
              {summary.deprecated} deprecated
            </span>
          )}
          {summary.stale && (
            <span className="toolbar__kpi" title="Registries were unreachable">
              cached
            </span>
          )}
        </div>
      </div>

      {/*
        Indeterminate on purpose: a scan reports no percentage, and a
        progressbar with no `aria-valuenow` is exactly how that is expressed.
        Stating the bounds without a value would claim a measurement we do not
        have.
      */}
      {busy && (
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={busyLabel ?? 'Scanning'}
        />
      )}
    </div>
  );
}
