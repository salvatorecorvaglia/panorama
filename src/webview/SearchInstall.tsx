/**
 * Registry search and install.
 *
 * The key interaction detail: when a result is already declared in one of the
 * open manifests, the primary action flips from Install to Uninstall, so the
 * button always does the thing that makes sense for the current state.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DepScope,
  Ecosystem,
  ProjectGroup,
  SearchResult,
} from '../core/types.js';
import { ECOSYSTEM_LABELS, formatDownloads } from './format.js';

interface Props {
  groups: ProjectGroup[];
  results: SearchResult[];
  error: string | undefined;
  searching: boolean;
  onSearch: (query: string, ecosystem: Ecosystem | 'all') => void;
  onInstall: (
    name: string,
    version: string | null,
    scope: DepScope,
    manifestPath: string,
  ) => void;
  onUninstall: (
    name: string,
    ecosystem: Ecosystem,
    manifestPath: string,
  ) => void;
}

const DEBOUNCE_MS = 300;

export function SearchInstall({
  groups,
  results,
  error,
  searching,
  onSearch,
  onInstall,
  onUninstall,
}: Props) {
  const [query, setQuery] = useState('');
  const [ecosystem, setEcosystem] = useState<Ecosystem | 'all'>('all');
  const [scope, setScope] = useState<DepScope>('prod');
  const [targetManifest, setTargetManifest] = useState<string>(
    groups[0]?.manifestPath ?? '',
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // Ecosystems actually present in this workspace — offering PyPI in a pure Go
  // project would just be noise.
  const availableEcosystems = useMemo(
    () => [...new Set(groups.map((group) => group.ecosystem))],
    [groups],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the install target valid as the workspace changes underneath us.
  useEffect(() => {
    if (!groups.some((group) => group.manifestPath === targetManifest)) {
      setTargetManifest(groups[0]?.manifestPath ?? '');
    }
  }, [groups, targetManifest]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    const timer = setTimeout(() => onSearch(trimmed, ecosystem), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, ecosystem, onSearch]);

  const selectedGroup = groups.find(
    (group) => group.manifestPath === targetManifest,
  );

  return (
    <div className="search-panel">
      <div className="toolbar">
        <div className="toolbar__row">
          <div className="toolbar__search">
            <input
              ref={inputRef}
              type="search"
              placeholder="Search registries to install a new package…"
              value={query}
              aria-label="Search registries"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <select
            value={ecosystem}
            aria-label="Registry"
            onChange={(event) =>
              setEcosystem(event.target.value as Ecosystem | 'all')
            }
          >
            <option value="all">All registries</option>
            {availableEcosystems.map((id) => (
              <option key={id} value={id}>
                {ECOSYSTEM_LABELS[id]}
              </option>
            ))}
          </select>

          <select
            value={targetManifest}
            aria-label="Install into"
            onChange={(event) => setTargetManifest(event.target.value)}
          >
            {groups.map((group) => (
              <option key={group.manifestPath} value={group.manifestPath}>
                {group.label}
              </option>
            ))}
          </select>

          <select
            value={scope}
            aria-label="Dependency scope"
            onChange={(event) => setScope(event.target.value as DepScope)}
          >
            <option value="prod">main</option>
            <option value="dev">dev</option>
            <option value="build">build</option>
            <option value="optional">optional</option>
          </select>
        </div>

        {query.trim().length > 0 && query.trim().length < 2 && (
          <div className="muted">Type at least two characters.</div>
        )}
      </div>

      {error && (
        <div className="callout callout--error" style={{ margin: 12 }}>
          {error}
        </div>
      )}

      {searching && results.length === 0 && (
        <div className="empty">Searching…</div>
      )}

      {!searching &&
        query.trim().length >= 2 &&
        results.length === 0 &&
        !error && (
          <div className="empty">
            <h2>No packages found</h2>
            <p>
              Note that Go and PyPI have no official search API — for those,
              type the exact module path or package name.
            </p>
          </div>
        )}

      {results.map((result) => {
        // Only count it as installed if it is in the manifest we would target.
        const installedHere = result.installedIn?.find(
          (entry) => entry.manifestPath === targetManifest,
        );
        const installedElsewhere = result.installedIn?.filter(
          (entry) => entry.manifestPath !== targetManifest,
        );
        const compatible =
          !selectedGroup || selectedGroup.ecosystem === result.ecosystem;

        return (
          <div
            className="search-result"
            key={`${result.ecosystem}:${result.name}`}
          >
            <div className="search-result__info">
              <div className="search-result__name">
                <span>{result.name}</span>
                {result.version && (
                  <span className="muted">{result.version}</span>
                )}
                <span className="badge">
                  {ECOSYSTEM_LABELS[result.ecosystem]}
                </span>
                {result.deprecated && (
                  <span className="icon-warn">▲ deprecated</span>
                )}
                {result.downloads !== undefined && (
                  <span className="muted">
                    {formatDownloads(result.downloads)} downloads
                  </span>
                )}
              </div>
              {result.description && (
                <div className="search-result__desc">{result.description}</div>
              )}
              {installedElsewhere && installedElsewhere.length > 0 && (
                <div className="muted" style={{ fontSize: '0.85em' }}>
                  Already in{' '}
                  {installedElsewhere
                    .map((entry) => entry.projectLabel)
                    .join(', ')}
                </div>
              )}
            </div>

            <div className="search-result__actions">
              {installedHere ? (
                <>
                  <span className="muted">{installedHere.declared}</span>
                  <button
                    className="danger"
                    onClick={() =>
                      onUninstall(result.name, result.ecosystem, targetManifest)
                    }
                  >
                    Uninstall
                  </button>
                </>
              ) : (
                <button
                  disabled={!compatible || !targetManifest}
                  title={
                    compatible
                      ? undefined
                      : `${result.name} is a ${ECOSYSTEM_LABELS[result.ecosystem]} package and cannot go into ${selectedGroup?.label}`
                  }
                  onClick={() =>
                    onInstall(
                      result.name,
                      result.version || null,
                      scope,
                      targetManifest,
                    )
                  }
                >
                  Install
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
