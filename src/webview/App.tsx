/**
 * Webview root: owns all UI state and routes host messages to it.
 *
 * Deliberately the only stateful component — everything below is presentational,
 * which keeps the message handling in one readable place.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HostMessage } from '../core/protocol.js';
import type {
  Dependency,
  DepNode,
  DepScope,
  Ecosystem,
  ProjectGroup,
  ScanSummary,
  SearchResult,
} from '../core/types.js';
import { DepTable, type SortState } from './DepTable.js';
import { DetailDrawer } from './DetailDrawer.js';
import { SearchInstall } from './SearchInstall.js';
import { type Filters, Toolbar } from './Toolbar.js';
import { loadState, onHostMessage, post, saveState } from './vscodeApi.js';

const ALL_SCOPES: DepScope[] = ['prod', 'dev', 'build', 'peer', 'optional'];

interface PersistedState {
  sort: SortState;
  scopes: DepScope[];
}

const EMPTY_SUMMARY: ScanSummary = {
  totalDependencies: 0,
  outdated: 0,
  vulnerable: 0,
  deprecated: 0,
  muted: 0,
  stale: false,
};

export function App() {
  const persisted = loadState<PersistedState>();

  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [summary, setSummary] = useState<ScanSummary>(EMPTY_SUMMARY);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const [sort, setSort] = useState<SortState>(
    persisted?.sort ?? { key: 'status', direction: 'asc' },
  );
  const [filters, setFilters] = useState<Filters>({
    text: '',
    scopes: new Set(persisted?.scopes ?? ALL_SCOPES),
    onlyOutdated: false,
    onlyVulnerable: false,
    onlyDeprecated: false,
    hideMuted: false,
  });

  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [scrollToKey, setScrollToKey] = useState<string | undefined>();
  const [whyByKey, setWhyByKey] = useState<
    Record<string, { roots: DepNode[]; source: 'lockfile' | 'registry' }>
  >({});

  const [installOpen, setInstallOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | undefined>();

  // Persist the bits of UI state worth surviving a reload.
  useEffect(() => {
    saveState<PersistedState>({ sort, scopes: [...filters.scopes] });
  }, [sort, filters.scopes]);

  useEffect(() => {
    const dispose = onHostMessage((message: HostMessage) => {
      switch (message.type) {
        case 'state':
          setGroups(message.groups);
          setSummary(message.summary);
          break;

        case 'scanning':
          setBusy(message.busy);
          setBusyLabel(message.label);
          break;

        case 'searchResults':
          setSearchResults(message.results);
          setSearchError(undefined);
          setSearching(false);
          setActiveRequestId(undefined);
          break;

        case 'searchError':
          setSearchError(message.message);
          setSearching(false);
          setActiveRequestId(undefined);
          break;

        case 'whyTree':
          setWhyByKey((current) => ({
            ...current,
            [message.depKey]: { roots: message.roots, source: message.source },
          }));
          break;

        case 'error':
          setError(message.message);
          break;

        case 'notice':
          setNotice(message.message);
          break;

        case 'focusSearch':
          setInstallOpen(true);
          break;

        case 'focusDependency':
          setSelectedKey(message.depKey);
          setScrollToKey(message.depKey);
          break;
      }
    });

    post({ type: 'ready' });
    return dispose;
  }, []);

  // Auto-dismiss transient banners so they do not pile up.
  useEffect(() => {
    if (!notice && !error) return;
    const timer = setTimeout(() => {
      setNotice(undefined);
      setError(undefined);
    }, 8000);
    return () => clearTimeout(timer);
  }, [notice, error]);

  const filteredGroups = useMemo(() => {
    const needle = filters.text.trim().toLowerCase();

    return groups
      .map((group) => ({
        ...group,
        dependencies: group.dependencies.filter((dep) => {
          if (!filters.scopes.has(dep.scope)) return false;
          if (needle && !dep.name.toLowerCase().includes(needle)) return false;
          if (
            filters.onlyOutdated &&
            !(
              dep.updateKind === 'patch' ||
              dep.updateKind === 'minor' ||
              dep.updateKind === 'major'
            )
          ) {
            return false;
          }
          if (filters.onlyVulnerable && dep.vulnerabilities.length === 0)
            return false;
          if (filters.onlyDeprecated && !dep.meta?.deprecated) return false;
          // Muted rows stay visible by default — hiding them would make it hard
          // to remember what you muted — but can be filtered out deliberately.
          if (filters.hideMuted && dep.muted) return false;
          return true;
        }),
      }))
      .filter((group) => group.dependencies.length > 0);
  }, [groups, filters]);

  const selected = useMemo(() => {
    if (!selectedKey) return undefined;
    for (const group of groups) {
      const dep = group.dependencies.find(
        (candidate) => candidate.key === selectedKey,
      );
      if (dep) return dep;
    }
    return undefined;
  }, [groups, selectedKey]);

  const handleSearch = useCallback(
    (query: string, ecosystem: Ecosystem | 'all') => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setSearching(true);
      setSearchError(undefined);
      setActiveRequestId(requestId);
      post({ type: 'search', query, ecosystem, requestId });
    },
    [],
  );

  // Cancel any in-flight search when the panel closes.
  useEffect(() => {
    if (!installOpen && activeRequestId) {
      post({ type: 'cancelSearch', requestId: activeRequestId });
      setActiveRequestId(undefined);
      setSearching(false);
    }
  }, [installOpen, activeRequestId]);

  const handleUpdate = useCallback((dep: Dependency) => {
    if (!dep.latest) return;
    post({ type: 'update', depKey: dep.key, toVersion: dep.latest });
  }, []);

  const handleUninstall = useCallback((dep: Dependency) => {
    post({ type: 'uninstall', depKey: dep.key });
  }, []);

  const handleUninstallByName = useCallback(
    (name: string, ecosystem: Ecosystem, manifestPath: string) => {
      for (const group of groups) {
        if (group.manifestPath !== manifestPath) continue;
        const dep = group.dependencies.find(
          (candidate) =>
            candidate.name === name && candidate.ecosystem === ecosystem,
        );
        if (dep) {
          post({ type: 'uninstall', depKey: dep.key });
          return;
        }
      }
    },
    [groups],
  );

  if (groups.length === 0 && !busy) {
    return (
      <div className="app">
        <div className="empty">
          <h2>No dependency manifests found</h2>
          <p>
            Panorama looks for package.json, pyproject.toml, requirements.txt,
            Cargo.toml, go.mod, composer.json, pom.xml and build.gradle anywhere
            in this workspace.
          </p>
          <button
            style={{ marginTop: 12 }}
            onClick={() => post({ type: 'refresh' })}
          >
            Scan again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar
        filters={filters}
        onFiltersChange={setFilters}
        summary={summary}
        busy={busy}
        busyLabel={busyLabel}
        installOpen={installOpen}
        onToggleInstall={() => setInstallOpen((open) => !open)}
        onRefresh={() => post({ type: 'refresh' })}
        onCheckUpdates={() => post({ type: 'checkUpdates' })}
      />

      {error && (
        <div className="callout callout--error" style={{ margin: 12 }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="callout callout--info" style={{ margin: 12 }}>
          {notice}
        </div>
      )}

      {installOpen && (
        <SearchInstall
          groups={groups}
          results={searchResults}
          error={searchError}
          searching={searching}
          onSearch={handleSearch}
          onInstall={(name, version, scope, manifestPath) =>
            post({ type: 'install', name, version, scope, manifestPath })
          }
          onUninstall={handleUninstallByName}
        />
      )}

      <div className="app__body">
        <div className="app__main">
          <DepTable
            groups={filteredGroups}
            sort={sort}
            onSortChange={setSort}
            selectedKey={selectedKey}
            onSelect={(dep) =>
              setSelectedKey(dep.key === selectedKey ? undefined : dep.key)
            }
            onUpdate={handleUpdate}
            onUninstall={handleUninstall}
            onUpdateAll={(manifestPath) =>
              post({ type: 'updateAll', manifestPath })
            }
            onToggleMute={(dep) =>
              post({ type: 'toggleMute', depKey: dep.key })
            }
            scrollToKey={scrollToKey}
          />
        </div>

        {selected && (
          <DetailDrawer
            dep={selected}
            why={whyByKey[selected.key]}
            onClose={() => setSelectedKey(undefined)}
            onUpdate={handleUpdate}
          />
        )}
      </div>
    </div>
  );
}
