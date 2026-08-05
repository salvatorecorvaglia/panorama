/** Search box, scope/status filters, and the project summary line. */

import type { DepScope, ScanSummary } from '../core/types.js';
import { SCOPE_LABELS } from './format.js';

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

const ALL_SCOPES: DepScope[] = ['prod', 'dev', 'build', 'peer', 'optional'];

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

  return (
    <div className="toolbar">
      <div className="toolbar__row">
        <div className="toolbar__search">
          <input
            type="search"
            placeholder="Filter installed packages…"
            value={filters.text}
            aria-label="Filter installed packages"
            onChange={(event) => onFiltersChange({ ...filters, text: event.target.value })}
          />
        </div>

        <button onClick={onToggleInstall} aria-pressed={installOpen}>
          {installOpen ? 'Close search' : '+ Add package'}
        </button>
        <button className="secondary" onClick={onCheckUpdates} disabled={busy}>
          Check updates
        </button>
        <button className="secondary" onClick={onRefresh} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="toolbar__row">
        {ALL_SCOPES.map((scope) => (
          <button
            key={scope}
            className="chip"
            aria-pressed={filters.scopes.has(scope)}
            onClick={() => toggleScope(scope)}
          >
            {SCOPE_LABELS[scope]}
          </button>
        ))}

        <span style={{ width: 12 }} />

        <button
          className="chip"
          aria-pressed={filters.onlyOutdated}
          onClick={() => onFiltersChange({ ...filters, onlyOutdated: !filters.onlyOutdated })}
        >
          outdated
        </button>
        <button
          className="chip"
          aria-pressed={filters.onlyVulnerable}
          onClick={() => onFiltersChange({ ...filters, onlyVulnerable: !filters.onlyVulnerable })}
        >
          vulnerable
        </button>
        <button
          className="chip"
          aria-pressed={filters.onlyDeprecated}
          onClick={() => onFiltersChange({ ...filters, onlyDeprecated: !filters.onlyDeprecated })}
        >
          deprecated
        </button>
        {summary.muted > 0 && (
          <button
            className="chip"
            aria-pressed={filters.hideMuted}
            title={`Hide the ${summary.muted} package(s) whose updates you have muted`}
            onClick={() => onFiltersChange({ ...filters, hideMuted: !filters.hideMuted })}
          >
            hide muted
          </button>
        )}

        <div className="toolbar__spacer" />

        <div className="toolbar__summary">
          {busy && busyLabel && <span>{busyLabel}</span>}
          <span>{summary.totalDependencies} packages</span>
          {summary.outdated > 0 && <span>{summary.outdated} outdated</span>}
          {summary.vulnerable > 0 && (
            <span className="icon-vuln">{summary.vulnerable} vulnerable</span>
          )}
          {summary.deprecated > 0 && (
            <span className="icon-warn">{summary.deprecated} deprecated</span>
          )}
          {summary.muted > 0 && <span title="Excluded from the outdated count">{summary.muted} muted</span>}
          {summary.stale && <span title="Registries were unreachable">cached</span>}
        </div>
      </div>

      {busy && <div className="progress" />}
    </div>
  );
}
