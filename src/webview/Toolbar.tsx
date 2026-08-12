/** Search box, scope/status filters, and the project summary line. */

import type { FocusEvent, KeyboardEvent, Ref } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Lets the app put the caret here from a keyboard shortcut. */
  filterRef?: Ref<HTMLInputElement>;
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

  /**
   * The buttons the toolbar roves over, in DOM order.
   *
   * Both the arrow-key handler and the tabindex effect read the list from here
   * so they cannot disagree about what "the next button" means — which they
   * would as soon as one of the conditional chips appeared.
   */
  const toolbarButtons = useCallback(
    (): HTMLElement[] => [
      ...(container.current?.querySelectorAll<HTMLElement>('button') ?? []),
    ],
    [],
  );

  /*
   * `role="toolbar"` is a promise that the whole group is one tab stop and that
   * arrows move within it. Declaring the role without this made the toolbar
   * *worse* than an undecorated set of buttons: assistive technology announces
   * a navigation model that then does not work.
   *
   * Keeping that promise takes both halves: arrows move between buttons (below)
   * *and* exactly one button is tabbable at a time (here). With every button
   * tabbable, Tab walked all twelve of them and the announced model was a lie.
   *
   * No dependency array: the button set itself changes with props — "hide
   * muted" comes and goes — so this has to re-sync after every render rather
   * than after a list of renders we tried to predict.
   */
  useEffect(() => {
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    // The remembered index can outlive the button it pointed at.
    const active = Math.min(activeIndex, buttons.length - 1);
    buttons.forEach((button, index) => {
      button.tabIndex = index === active ? 0 : -1;
    });
  });

  /*
   * The text inputs are excluded — arrow keys there move the caret, which is
   * what anyone typing in them expects.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;

    const focusable = toolbarButtons();
    const index = focusable.indexOf(target);
    if (index < 0) return;

    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    // Wrap, so the ends of the toolbar are not dead stops.
    const next = (index + step + focusable.length) % focusable.length;
    setActiveIndex(next);
    focusable[next]?.focus();
  };

  // Clicking or shift-tabbing onto a button makes it the tab stop, so leaving
  // and re-entering the toolbar returns to where the user actually was.
  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = toolbarButtons().indexOf(event.target as HTMLElement);
    if (index >= 0) setActiveIndex(index);
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
        {/*
          A <legend> rather than aria-label: a fieldset's accessible name comes
          from its legend, and support for naming one with aria-label is
          inconsistent across screen readers.

          The legends are visible because the two chip families look identical
          and behave in opposite directions. Scope chips start all-on and
          subtract; status chips start all-off and each one narrows to "only
          this". Seven identical pills in a row gave no hint of that, and the
          first thing anyone tried — clicking "outdated" expecting it to work
          like the scope chips beside it — did the opposite of what they meant.

          The chips sit in their own flex child rather than in the fieldset
          directly: a fieldset with `display: flex` hands the flex formatting to
          an anonymous box and keeps the legend out of it, which is engine
          territory this layout should not be standing on.
        */}
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
          </div>
        </fieldset>

        <div className="toolbar__spacer" />

        {/*
          Visible, but not announced here: the progressbar below already carries
          this text as its accessible name. Inside the summary's live region it
          was read out a second time, and its appearance and disappearance made
          the region re-announce every count along with it — so finishing a scan
          spoke the same numbers three times.
        */}
        {busy && busyLabel && (
          <span className="muted" aria-hidden="true">
            {busyLabel}
          </span>
        )}

        <div className="toolbar__summary" role="status">
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
