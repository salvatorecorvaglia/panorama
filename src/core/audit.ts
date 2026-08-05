/**
 * Vulnerability data from OSV.dev.
 *
 * OSV is the right source here because one API covers every ecosystem Panorama
 * supports, and `querybatch` lets a whole project be checked in a couple of
 * round-trips: the batch call returns only IDs, and we fetch full records for
 * the small subset that actually matched.
 */

import type { ProviderContext } from '../providers/provider.js';
import { providerFor } from '../providers/registry.js';
import { cacheKey, TTL } from './cache.js';
import type { ProjectGroup, Severity, Vulnerability } from './types.js';

const OSV_API = 'https://api.osv.dev';
const MAX_BATCH = 500;

interface OsvBatchResponse {
  results: Array<{ vulns?: Array<{ id: string }> }>;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{
      type: string;
      events: Array<{ introduced?: string; fixed?: string }>;
    }>;
  }>;
}

/**
 * Decorates every dependency in `groups` with its known advisories, in place.
 *
 * Failures are swallowed on purpose: a missing audit should grey out a badge,
 * not break the dependency table.
 */
export async function auditDependencies(
  groups: ProjectGroup[],
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<void> {
  // Build the query set, remembering which dependencies each query maps back to.
  interface Query {
    package: { name: string; ecosystem: string };
    version: string;
  }
  const queries: Query[] = [];
  const owners: Array<Array<{ group: ProjectGroup; index: number }>> = [];
  const seen = new Map<string, number>();

  for (const group of groups) {
    const provider = providerFor(group.ecosystem);
    const osvEcosystem = provider.osvEcosystem;
    if (!osvEcosystem) continue;

    group.dependencies.forEach((dep, index) => {
      // OSV matches on a concrete version; a range tells it nothing.
      const version = dep.installed;
      if (!version) return;

      const identity = `${osvEcosystem}|${dep.name}|${version}`;
      const existing = seen.get(identity);
      if (existing !== undefined) {
        owners[existing].push({ group, index });
        return;
      }

      seen.set(identity, queries.length);
      queries.push({
        package: { name: dep.name, ecosystem: osvEcosystem },
        version,
      });
      owners.push([{ group, index }]);
    });
  }

  if (queries.length === 0) return;

  // Batch, then fetch details only for the IDs that came back.
  const idsPerQuery: Array<string[]> = new Array(queries.length)
    .fill(null)
    .map(() => []);

  for (let offset = 0; offset < queries.length; offset += MAX_BATCH) {
    const slice = queries.slice(offset, offset + MAX_BATCH);
    const response = await ctx.http.postJson<OsvBatchResponse>(
      `${OSV_API}/v1/querybatch`,
      { queries: slice },
      { signal },
    );
    response.results.forEach((result, i) => {
      idsPerQuery[offset + i] = (result.vulns ?? []).map((vuln) => vuln.id);
    });
  }

  const uniqueIds = [...new Set(idsPerQuery.flat())];
  if (uniqueIds.length === 0) return;

  const details = await fetchVulnerabilities(uniqueIds, ctx, signal);

  idsPerQuery.forEach((ids, queryIndex) => {
    if (ids.length === 0) return;
    const resolved = ids
      .map((id) => details.get(id))
      .filter((vuln): vuln is Vulnerability => vuln !== undefined);
    if (resolved.length === 0) return;

    for (const owner of owners[queryIndex]) {
      owner.group.dependencies[owner.index].vulnerabilities = resolved;
    }
  });
}

async function fetchVulnerabilities(
  ids: string[],
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<Map<string, Vulnerability>> {
  const result = new Map<string, Vulnerability>();

  // Bounded concurrency: advisory records are small but there can be many.
  const CONCURRENCY = 8;
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        const key = cacheKey('osv', 'vuln', id);

        const cached = ctx.cache.get<Vulnerability>(key);
        if (cached) {
          result.set(id, cached);
          continue;
        }

        try {
          const raw = await ctx.http.getJson<OsvVuln>(
            `${OSV_API}/v1/vulns/${id}`,
            { signal },
          );
          const vuln = toVulnerability(raw);
          result.set(id, vuln);
          await ctx.cache.set(key, vuln, TTL.audit);
        } catch {
          // A single missing advisory should not abort the audit.
        }
      }
    }),
  );

  return result;
}

function toVulnerability(raw: OsvVuln): Vulnerability {
  // Prefer the first fixed version any range reports — that is what the user
  // needs to upgrade to.
  let fixedVersion: string | undefined;
  for (const affected of raw.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events) {
        if (event.fixed) {
          fixedVersion ??= event.fixed;
        }
      }
    }
  }

  return {
    id: raw.id,
    summary: raw.summary ?? raw.details?.slice(0, 200) ?? 'No summary provided',
    severity: deriveSeverity(raw),
    aliases: raw.aliases ?? [],
    fixedVersion,
    url: `https://osv.dev/vulnerability/${raw.id}`,
  };
}

/**
 * OSV reports severity two ways: a database-specific label, or a CVSS vector.
 * We prefer the label and fall back to bucketing the CVSS base score.
 */
function deriveSeverity(raw: OsvVuln): Severity {
  const label = raw.database_specific?.severity?.toLowerCase();
  if (
    label === 'critical' ||
    label === 'high' ||
    label === 'moderate' ||
    label === 'low'
  ) {
    return label;
  }
  if (label === 'medium') return 'moderate';

  const cvss = raw.severity?.find((entry) => entry.type.startsWith('CVSS'));
  if (cvss) {
    const score = parseCvssBaseScore(cvss.score);
    if (score !== undefined) {
      if (score >= 9) return 'critical';
      if (score >= 7) return 'high';
      if (score >= 4) return 'moderate';
      return 'low';
    }
  }

  return 'moderate';
}

/**
 * OSV's `score` is usually a CVSS vector string rather than a number. Deriving
 * a full base score from the vector is out of scope, so we read a numeric score
 * when one is given and otherwise let the caller's default stand.
 */
function parseCvssBaseScore(score: string): number | undefined {
  const numeric = Number(score);
  if (Number.isFinite(numeric)) return numeric;
  return undefined;
}
