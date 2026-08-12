/**
 * Registry adapters that talk to a network: Maven Central's Solr API, and the
 * repository/changelog URL normalisation every provider feeds its links through.
 */

import { describe, expect, it, vi } from 'vitest';
import { PythonProvider } from '../../src/providers/python/index.js';
import {
  fetchMavenVersions,
  searchMavenCentral,
  splitCoordinate,
} from '../../src/providers/shared/mavenCentral.js';
import {
  changelogUrlFor,
  normalizeRepositoryUrl,
} from '../../src/providers/shared/repository.js';
import { makeContext } from './helpers.js';

/** A context whose http returns one scripted JSON body. */
function withResponse(body: unknown) {
  const ctx = makeContext();
  // Typed with the URL parameter so `mock.calls` can be asserted on.
  const getJson = vi.fn((_url: string) => Promise.resolve(body));
  return {
    ctx: { ...ctx, http: { ...ctx.http, getJson } as never },
    getJson,
  };
}

describe('splitCoordinate', () => {
  it('splits a groupId:artifactId pair', () => {
    expect(splitCoordinate('com.google.guava:guava')).toEqual({
      groupId: 'com.google.guava',
      artifactId: 'guava',
    });
  });

  it('rejects anything that is not a full coordinate', () => {
    expect(splitCoordinate('guava')).toBeNull();
    expect(splitCoordinate(':guava')).toBeNull();
    expect(splitCoordinate('com.google:')).toBeNull();
  });
});

describe('fetchMavenVersions', () => {
  it('queries the group and artifact fields rather than free text', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 2, docs: [{ v: '1.0' }, { v: '2.0' }] },
    });

    await fetchMavenVersions(['com.google.guava:guava'], ctx);

    const url = getJson.mock.calls[0][0];
    expect(url).toContain('g:com.google.guava');
    expect(url).toContain('a:guava');
    // core=gav returns one document per version rather than per artifact.
    expect(url).toContain('core=gav');
  });

  it('picks the highest stable version as latest', async () => {
    const { ctx } = withResponse({
      response: {
        numFound: 3,
        docs: [{ v: '1.0' }, { v: '3.0-SNAPSHOT' }, { v: '2.0' }],
      },
    });

    const result = await fetchMavenVersions(['g:a'], ctx);
    expect(result.get('g:a')?.latest).toBe('2.0');
    expect(result.get('g:a')?.versions).toHaveLength(3);
  });

  it('skips names that are not coordinates instead of querying for them', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 0, docs: [] },
    });

    const result = await fetchMavenVersions(['not-a-coordinate'], ctx);
    expect(result.size).toBe(0);
    expect(getJson).not.toHaveBeenCalled();
  });

  it('serves a cached result without a second request', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 1, docs: [{ v: '1.0' }] },
    });

    await fetchMavenVersions(['g:a'], ctx);
    await fetchMavenVersions(['g:a'], ctx);
    expect(getJson).toHaveBeenCalledOnce();
  });

  it('returns nothing rather than throwing when Solr is unreachable', async () => {
    // makeContext's http rejects every call.
    const result = await fetchMavenVersions(['g:a'], makeContext());
    expect(result.size).toBe(0);
  });
});

describe('searchMavenCentral', () => {
  it('queries the fields directly when the user types a full coordinate', async () => {
    const { ctx, getJson } = withResponse({
      response: { numFound: 0, docs: [] },
    });

    await searchMavenCentral('com.google.guava:guava', 'maven', ctx);
    expect(getJson.mock.calls[0][0]).toContain(
      'g:com.google.guava+AND+a:guava',
    );
  });

  it('maps documents onto coordinates with a browsable link', async () => {
    const { ctx } = withResponse({
      response: {
        numFound: 1,
        docs: [{ id: 'x', g: 'com.acme', a: 'lib', latestVersion: '3.1' }],
      },
    });

    expect(await searchMavenCentral('lib', 'gradle', ctx)).toEqual([
      {
        name: 'com.acme:lib',
        version: '3.1',
        ecosystem: 'gradle',
        repository: 'https://central.sonatype.com/artifact/com.acme/lib',
      },
    ]);
  });
});

describe('normalizeRepositoryUrl', () => {
  it('resolves the shorthand forms package.json allows', () => {
    expect(normalizeRepositoryUrl('github:foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('gitlab:foo/bar')).toBe(
      'https://gitlab.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('bitbucket:foo/bar')).toBe(
      'https://bitbucket.org/foo/bar',
    );
    expect(normalizeRepositoryUrl('foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('rewrites git transports to something a browser can open', () => {
    expect(normalizeRepositoryUrl('git+https://github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('git://github.com/foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('git@github.com:foo/bar.git')).toBe(
      'https://github.com/foo/bar',
    );
    expect(normalizeRepositoryUrl('ssh://git@github.com/foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('strips credentials rather than putting them in a clickable link', () => {
    expect(normalizeRepositoryUrl('https://user:pass@github.com/foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('declines anything that is not http(s) once normalised', () => {
    expect(normalizeRepositoryUrl(undefined)).toBeUndefined();
    expect(normalizeRepositoryUrl('   ')).toBeUndefined();
    expect(normalizeRepositoryUrl('file:///etc/passwd')).toBeUndefined();
    expect(normalizeRepositoryUrl('javascript:alert(1)')).toBeUndefined();
  });
});

describe('changelogUrlFor', () => {
  it('points at the releases page, which is likelier to exist than a file', () => {
    expect(changelogUrlFor('https://github.com/foo/bar')).toBe(
      'https://github.com/foo/bar/releases',
    );
    expect(changelogUrlFor('https://gitlab.com/foo/bar')).toBe(
      'https://gitlab.com/foo/bar/-/releases',
    );
  });

  it('offers nothing for forges whose layout it does not know', () => {
    expect(changelogUrlFor('https://bitbucket.org/foo/bar')).toBeUndefined();
    expect(changelogUrlFor(undefined)).toBeUndefined();
    expect(changelogUrlFor('not a url')).toBeUndefined();
  });
});

/**
 * PyPI's simple index makes no promise about the order of `versions`, so the
 * version offered for install has to be chosen by PEP 440 rather than by
 * position. Taking the last entry offered whatever PyPI happened to list last.
 */
describe('PythonProvider.search', () => {
  /** Routes each of the three calls `search` makes to its own scripted body. */
  function withPyPi(versions: string[]) {
    const ctx = makeContext();
    const getJson = vi.fn((url: string) => {
      if (url.endsWith('/json')) {
        return Promise.resolve({
          info: { name: 'requests', summary: 'HTTP for Humans' },
          urls: [],
        });
      }
      if (/\/simple\/[^/]+\/$/.test(url)) {
        return Promise.resolve({ versions });
      }
      // The full project index, used for the substring-match fallback.
      return Promise.resolve({ projects: [] });
    });
    return { ...ctx, http: { ...ctx.http, getJson } as never };
  }

  it('offers the highest version, not the last one listed', async () => {
    const provider = new PythonProvider();
    // Deliberately unsorted, with the newest release in the middle and an
    // older patch last — the shape that made the previous implementation wrong.
    const results = await provider.search(
      'requests',
      withPyPi(['2.28.0', '2.32.3', '2.31.0', '2.9.1']),
    );

    expect(results[0].name).toBe('requests');
    expect(results[0].version).toBe('2.32.3');
  });

  it('prefers a stable release over a later prerelease', async () => {
    const provider = new PythonProvider();
    const results = await provider.search(
      'requests',
      withPyPi(['2.31.0', '3.0.0rc1']),
    );

    expect(results[0].version).toBe('2.31.0');
  });

  it('offers no version rather than a wrong one when nothing is published', async () => {
    const provider = new PythonProvider();
    const results = await provider.search('requests', withPyPi([]));

    expect(results[0].version).toBe('');
  });
});

describe('searchMavenCentral encoding', () => {
  it('encodes both halves of a typed coordinate', async () => {
    // The query is a text box. An unencoded `&` would end the `q` parameter
    // early and change what Solr was actually asked.
    const { ctx, getJson } = withResponse({
      response: { numFound: 0, docs: [] },
    });

    await searchMavenCentral('com.example&x:widget#y', 'maven', ctx);

    const url = getJson.mock.calls[0][0];
    expect(url).toContain('g:com.example%26x');
    expect(url).toContain('a:widget%23y');
    expect(url).not.toContain('&x:');
  });
});
