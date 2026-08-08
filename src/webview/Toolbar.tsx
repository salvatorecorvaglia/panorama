/** Search box, scope/status filters, and the project summary line. */

import type { KeyboardEvent } from 'react';
import { useRef } from 'react';
import type { DepScope, ScanSummary } from '../core/types.js';
import { ALL_SCOPES, SCOPE_LABELS } from '../core/vocabulary.js';

export interface Filters {
  text: string;
  scopes: Set<DepScope>;
  onlyOutdated: boolean;
  onlyVulnerable: boolean;
  onlyDeprecated: boolean;
  hideMuted: boolean;
}

interface Props {
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  summary: ScanSummary;
  busy: boolean;
  busyLabel: string | undefined;
  onRefresh: () => void;
  onCheckUpdates: () => void;
  onToggleInstall: () => void;
  installOpen: boolean;
}

export function Toolbar({
  filters,
  onFiltersChange,
  summary,
  busy,
  busyLabel,
  onRefresh,
  onCheckUpdates,
  onToggleInstall,
  installOpen,
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

  /*
   * `role="toolbar"` is a promise that the whole group is one tab stop and that
   * arrows move within it. Declaring the role without this made the toolbar
   * *worse* than an undecorated set of buttons: assistive technology announces
   * a navigation model that then does not work.
   *
   * The text inputs are excluded — arrow keys there move the caret, which is
   * what anyone typing in them expects.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;

    const focusable = [
      ...(container.current?.querySelectorAll<HTMLElement>('button') ?? []),
    ];
    const index = focusable.indexOf(target);
    if (index < 0) return;

    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    // Wrap, so the ends of the toolbar are not dead stops.
    const next = (index + step + focusable.length) % focusable.length;
    focusable[next]?.focus();
  };

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Panorama actions"
      ref={container}
      onKeyDown={handleKeyDown}
    >
      <div className="toolbar__row">
        <div className="toolbar__search">
          <input
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
          onClick={onToggleInstall}
          aria-expanded={installOpen}
          aria-controls="panorama-search-panel"
        >
          {installOpen ? 'Close search' : '+ Add package'}
        </button>
        {/* These two look alike, so each one says what it actually does. */}
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

      <div className="toolbar__row">
        <fieldset className="toolbar__group" aria-label="Filter by scope">
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
        </fieldset>

        <fieldset className="toolbar__group" aria-label="Filter by status">
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
          {summary.muted > 0 && (
            <button
              type="button"
              className="chip"
              aria-pressed={filters.hideMuted}
              title={`Hide the ${summary.muted} package(s) whose updates you have muted`}
              onClick={() =>
                onFiltersChange({ ...filters, hideMuted: !filters.hideMuted })
              }
            >
              hide muted
            </button>
          )}
        </fieldset>

        <div className="toolbar__spacer" />

        <div className="toolbar__summary" role="status">
          {busy && busyLabel && <span>{busyLabel}</span>}
          <span>{summary.totalDependencies} packages</span>
          {summary.outdated > 0 && <span>{summary.outdated} outdated</span>}
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
          {summary.muted > 0 && (
            <span title="Excluded from the outdated count">
              {summary.muted} muted
            </span>
          )}
          {summary.stale && (
            <span title="Registries were unreachable">cached</span>
          )}
        </div>
      </div>

      {/* Indeterminate: the scan reports no fraction, only that it is running. */}
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
