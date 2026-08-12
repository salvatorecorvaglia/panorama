/**
 * Maven Central's Solr search API, shared by the Maven and Gradle providers.
 *
 * Coordinates are `groupId:artifactId`, so everything here splits on the colon
 * and queries the `g:` / `a:` fields rather than doing free-text matching.
 */

import { cacheKey, TTL } from '../../core/cache.js';
import type { Ecosystem, PackageMeta, SearchResult } from '../../core/types.js';
import { maxMaven } from '../../core/versions/maven.js';
import type { ProviderContext, VersionInfo } from '../provider.js';
import { mapWithConcurrency } from './concurrency.js';

const SOLR = 'https://search.maven.org/solrsearch/select';

interface SolrResponse {
  response: {
    numFound: number;
    docs: Array<{
      id: string;
      g: string;
      a: string;
      v?: string;
      latestVersion?: string;
      p?: string;
      timestamp?: number;
    }>;
  };
}

export function splitCoordinate(
  name: string,
): { groupId: string; artifactId: string } | null {
  const parts = name.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { groupId: parts[0], artifactId: parts[1] };
}

export async function fetchMavenVersions(
  names: string[],
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<Map<string, VersionInfo>> {
  const result = new Map<string, VersionInfo>();

  /*
   * Five at a time, matching the per-host limit `core/http.ts` applies to
   * search.maven.org. One request per artifact is unavoidable — Solr has no
   * batch form for this — but issuing them strictly one after another left the
   * rate limiter idle and made a Maven project's scan take as many round-trips
   * in series as it has dependencies.
   */
  await mapWithConcurrency(names, 5, async (name) => {
    const coordinate = splitCoordinate(name);
    if (!coordinate) return;

    const key = cacheKey('maven', 'versions', name);
    const cached = ctx.cache.get<VersionInfo>(key);
    if (cached) {
      result.set(name, cached);
      return;
    }

    try {
      // core=gav returns one document per version rather than per artifact.
      const url =
        `${SOLR}?q=g:${encodeURIComponent(coordinate.groupId)}+AND+a:${encodeURIComponent(coordinate.artifactId)}` +
        `&core=gav&rows=200&wt=json`;
      const response = await ctx.http.getJson<SolrResponse>(url, { signal });

      const versions = response.response.docs
        .map((doc) => doc.v)
        .filter((version): version is string => Boolean(version));
      if (versions.length === 0) return;

      const info: VersionInfo = { versions, latest: maxMaven(versions) };
      result.set(name, info);
      await ctx.cache.set(key, info, TTL.version);
    } catch {
      const stale = ctx.cache.getStale<VersionInfo>(key);
      if (stale) result.set(name, stale);
    }
  });

  return result;
}

export async function fetchMavenMetadata(
  name: string,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<PackageMeta | undefined> {
  const coordinate = splitCoordinate(name);
  if (!coordinate) return undefined;

  const key = cacheKey('maven', 'meta', name);
  const cached = ctx.cache.get<PackageMeta>(key);
  if (cached) return cached;

  // Solr carries no descriptions or licences, so we provide reliable links to
  // where that information actually lives rather than inventing fields.
  const meta: PackageMeta = {
    name,
    homepage: `https://central.sonatype.com/artifact/${coordinate.groupId}/${coordinate.artifactId}`,
  };

  try {
    await ctx.cache.set(key, meta, TTL.metadata);
  } catch {
    // Caching is best-effort.
  }
  void signal;
  return meta;
}

export async function searchMavenCentral(
  query: string,
  ecosystem: Ecosystem,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  // A colon means the user typed a full coordinate; query the fields directly.
  // Both halves are encoded, as they are in `fetchMavenVersions` — the query
  // comes from a text box, and a `&` or `#` in it would otherwise end the
  // parameter early and change what was asked.
  const coordinate = query.includes(':') ? splitCoordinate(query) : null;
  const q = coordinate
    ? `g:${encodeURIComponent(coordinate.groupId)}+AND+a:${encodeURIComponent(coordinate.artifactId)}`
    : encodeURIComponent(query);

  const response = await ctx.http.getJson<SolrResponse>(
    `${SOLR}?q=${q}&rows=25&wt=json`,
    { signal },
  );

  return response.response.docs.map((doc) => ({
    name: `${doc.g}:${doc.a}`,
    version: doc.latestVersion ?? doc.v ?? '',
    ecosystem,
    repository: `https://central.sonatype.com/artifact/${doc.g}/${doc.a}`,
  }));
}
