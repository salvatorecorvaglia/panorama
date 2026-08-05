/**
 * The per-package detail panel: metadata, advisories, and the reverse
 * dependency tree that answers "why is this here?".
 */

import { useEffect } from 'react';
import type { Dependency, DepNode } from '../core/types.js';
import { currentVersion, ECOSYSTEM_LABELS, formatBytes } from './format.js';
import { post } from './vscodeApi.js';

interface Props {
  dep: Dependency;
  why: { roots: DepNode[]; source: 'lockfile' | 'registry' } | undefined;
  onClose: () => void;
  onUpdate: (dep: Dependency) => void;
}

export function DetailDrawer({ dep, why, onClose, onUpdate }: Props) {
  // Metadata and the dependency tree are fetched lazily — pulling them for
  // every row up front would mean thousands of needless registry calls.
  useEffect(() => {
    post({ type: 'requestDetails', depKey: dep.key });
    post({ type: 'requestWhy', depKey: dep.key });
  }, [dep.key]);

  const openLink = (url: string) => post({ type: 'openExternal', url });

  return (
    <aside className="drawer" aria-label={`Details for ${dep.name}`}>
      <div className="drawer__title">
        <h2>{dep.name}</h2>
        <button className="ghost" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>

      <div className="muted" style={{ marginBottom: 12 }}>
        {ECOSYSTEM_LABELS[dep.ecosystem]} · {dep.projectLabel}
      </div>

      {dep.meta?.deprecated && (
        <div className="callout callout--warn">
          <strong>Deprecated.</strong> {dep.meta.deprecated}
        </div>
      )}

      {dep.lookupFailed && (
        <div className="callout callout--info">
          Could not reach the registry for this package, so version information
          may be missing or out of date.
        </div>
      )}

      {dep.meta?.description && (
        <p style={{ marginTop: 0 }}>{dep.meta.description}</p>
      )}

      <section>
        <h3>Versions</h3>
        <dl>
          <dt>Declared</dt>
          <dd>
            <code>{dep.declared}</code>
          </dd>
          <dt>Installed</dt>
          <dd>
            <code>{currentVersion(dep)}</code>
          </dd>
          {dep.wanted && dep.wanted !== dep.installed && (
            <>
              <dt title="Highest version allowed by the declared range">
                Wanted
              </dt>
              <dd>
                <code>{dep.wanted}</code>
              </dd>
            </>
          )}
          <dt>Latest</dt>
          <dd>
            <code>{dep.latest ?? '—'}</code>
          </dd>
        </dl>

        {dep.latest &&
          dep.updateKind !== 'none' &&
          dep.updateKind !== 'unknown' && (
            <button style={{ marginTop: 10 }} onClick={() => onUpdate(dep)}>
              Update to {dep.latest}
              {dep.updateKind === 'major' ? ' (major)' : ''}
            </button>
          )}
      </section>

      <section>
        <h3>Package</h3>
        <dl>
          <dt>License</dt>
          <dd>{dep.meta?.license ?? '—'}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(dep.meta?.sizeBytes)}</dd>
          {dep.meta?.author && (
            <>
              <dt>Author</dt>
              <dd>{dep.meta.author}</dd>
            </>
          )}
        </dl>

        {(() => {
          const homepage = dep.meta?.homepage;
          const repository = dep.meta?.repository;
          const changelogUrl = dep.meta?.changelogUrl;
          return (
            <div
              style={{
                display: 'flex',
                gap: 12,
                marginTop: 10,
                flexWrap: 'wrap',
              }}
            >
              {homepage && (
                <button className="link" onClick={() => openLink(homepage)}>
                  Homepage
                </button>
              )}
              {repository && (
                <button className="link" onClick={() => openLink(repository)}>
                  Repository
                </button>
              )}
              {changelogUrl && (
                <button className="link" onClick={() => openLink(changelogUrl)}>
                  Changelog
                </button>
              )}
              <button
                className="link"
                onClick={() =>
                  post({
                    type: 'openManifest',
                    manifestPath: dep.manifestPath,
                    packageName: dep.name,
                  })
                }
              >
                Open manifest
              </button>
            </div>
          );
        })()}
      </section>

      {dep.vulnerabilities.length > 0 && (
        <section>
          <h3>Security ({dep.vulnerabilities.length})</h3>
          {dep.vulnerabilities.map((vuln) => (
            <div key={vuln.id} className="callout callout--error">
              <div>
                <strong>{vuln.severity.toUpperCase()}</strong> ·{' '}
                <button className="link" onClick={() => openLink(vuln.url)}>
                  {vuln.id}
                </button>
              </div>
              <div style={{ marginTop: 4 }}>{vuln.summary}</div>
              {vuln.fixedVersion && (
                <div style={{ marginTop: 4 }}>
                  Fixed in <code>{vuln.fixedVersion}</code>
                </div>
              )}
              {vuln.aliases.length > 0 && (
                <div
                  className="muted"
                  style={{ marginTop: 4, fontSize: '0.9em' }}
                >
                  {vuln.aliases.join(', ')}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section>
        <h3>Why is this installed?</h3>
        {why === undefined ? (
          <div className="muted">Resolving…</div>
        ) : why.roots.length === 0 ? (
          <div className="muted">
            No dependency graph available. Install the project to generate a
            lockfile and this will fill in.
          </div>
        ) : (
          <>
            <div
              className="muted"
              style={{ marginBottom: 8, fontSize: '0.9em' }}
            >
              {why.source === 'lockfile'
                ? 'From this project’s lockfile.'
                : 'Resolved from the registry — no local lockfile was found.'}
            </div>
            <div className="tree">
              <NodeList nodes={why.roots} depth={0} />
            </div>
          </>
        )}
      </section>
    </aside>
  );
}

function NodeList({ nodes, depth }: { nodes: DepNode[]; depth: number }) {
  // A hard stop keeps a pathological graph from locking up the renderer.
  if (depth > 8) {
    return (
      <ul>
        <li className="muted">…</li>
      </ul>
    );
  }

  return (
    <ul>
      {nodes.map((node) => (
        <li
          key={`${node.name}-${node.version ?? ''}-${node.requestedRange ?? ''}`}
        >
          {node.name}
          {node.version && <span className="muted"> {node.version}</span>}
          {node.requestedRange && (
            <span className="muted"> ({node.requestedRange})</span>
          )}
          {node.children.length > 0 && (
            <NodeList nodes={node.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}
