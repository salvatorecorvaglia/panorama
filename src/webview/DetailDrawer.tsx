/**
 * The per-package detail panel: metadata, advisories, and the reverse
 * dependency tree that answers "why is this here?".
 */

import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';
import type { Dependency, DepNode } from '../core/types.js';
import { currentVersion } from '../core/vocabulary.js';
import { ECOSYSTEM_LABELS, formatBytes } from './format.js';
import { post } from './vscodeApi.js';

interface Props {
  dep: Dependency;
  why: { roots: DepNode[]; source: 'lockfile' | 'registry' } | undefined;
  /** Which section the command that opened this drawer wants to land on. */
  reveal: 'details' | 'why';
  onClose: () => void;
  onUpdate: (dep: Dependency) => void;
}

export function DetailDrawer({ dep, why, reveal, onClose, onUpdate }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const whyRef = useRef<HTMLElement>(null);
  /** The element that had focus when the drawer opened, to restore on close. */
  const returnFocusRef = useRef<Element | null>(null);

  // Metadata and the dependency tree are fetched lazily — pulling them for
  // every row up front would mean thousands of needless registry calls.
  useEffect(() => {
    post({ type: 'requestDetails', depKey: dep.key });
    post({ type: 'requestWhy', depKey: dep.key });
  }, [dep.key]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    return () => {
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement && document.contains(target)) {
        target.focus();
      }
    };
  }, []);

  /*
   * "Why Is This Installed?" opens this drawer specifically to answer that
   * question, but the Why tree is the last section — without this the user
   * lands at the top and has to go looking for what they asked for.
   *
   * `dep.key` is in the dependency list so that asking "why" about a second
   * package reveals the section again rather than leaving the drawer wherever
   * the previous package left it.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (reveal === 'why') {
      whyRef.current?.scrollIntoView({ block: 'start' });
    } else {
      headingRef.current?.focus();
    }
  }, [reveal, dep.key]);

  const openLink = (url: string) => post({ type: 'openExternal', url });
  const { homepage, repository, changelogUrl } = dep.meta ?? {};

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <aside
      className="drawer"
      aria-label={`Details for ${dep.name}`}
      onKeyDown={handleKeyDown}
    >
      <div className="drawer__title">
        {/* Focusable so opening the drawer moves the caret somewhere sensible. */}
        <h2 ref={headingRef} tabIndex={-1}>
          {dep.name}
        </h2>
        <button className="ghost" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>

      <div className="muted drawer__subtitle">
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
        <p className="drawer__desc">{dep.meta.description}</p>
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
            <button className="drawer__action" onClick={() => onUpdate(dep)}>
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

        <div className="drawer__links">
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
              <div className="callout__line">{vuln.summary}</div>
              {vuln.fixedVersion && (
                <div className="callout__line">
                  Fixed in <code>{vuln.fixedVersion}</code>
                </div>
              )}
              {vuln.aliases.length > 0 && (
                <div className="muted callout__aliases">
                  {vuln.aliases.join(', ')}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section ref={whyRef}>
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
            <div className="muted drawer__why-source">
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
