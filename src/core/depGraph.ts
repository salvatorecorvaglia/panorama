/**
 * "Why is this installed?" — reverse dependency resolution.
 *
 * Accuracy comes first, so a local lockfile is always preferred: it describes
 * the tree that actually exists on disk. deps.dev is the fallback for projects
 * with no lockfile (a fresh clone, or Maven/Gradle), where the answer is
 * necessarily "what a resolver would produce" rather than "what you have".
 */

import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProviderContext } from '../providers/provider.js';
// The one PEP 503 implementation. A second copy lived here to avoid depending
// on a provider, but this file already imports the provider registry, and two
// normalisers that must agree exactly are two that can silently stop agreeing.
import { normalizeName as normalizePythonName } from '../providers/python/index.js';
import { providerFor } from '../providers/registry.js';
import type { Dependency, DepNode, Ecosystem } from './types.js';

const MAX_DEPTH = 8;

/**
 * How many distinct chains the reverse walk may collect before giving up.
 *
 * Well past what anyone reads, and far below what a dense lockfile can produce.
 */
const MAX_CHAINS = 200;

export interface WhyResult {
  roots: DepNode[];
  source: 'lockfile' | 'registry';
}

/**
 * Builds the chain(s) of dependencies that lead to `target`.
 *
 * The returned tree is oriented from the direct dependency downwards, which is
 * how people read it: "eslint → chalk → ansi-styles".
 */
export async function explainDependency(
  target: Dependency,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<WhyResult> {
  const forward = await buildForwardGraph(target, ctx);
  // Reading and parsing a large lockfile is not instant; a caller that has
  // moved on should not pay for the walk as well.
  if (signal?.aborted) return { roots: [], source: 'lockfile' };

  if (forward && forward.size > 0) {
    // The lookup key must go through the same normalisation the graph keys did,
    // or a manifest that declares `Jinja2` will never match a lockfile that
    // records `jinja2`.
    const roots = tracePaths(forward, graphKey(target.name, target.ecosystem));
    if (roots.length > 0) {
      return { roots, source: 'lockfile' };
    }
  }

  const registryTree = await buildFromDepsDev(target, ctx, signal);
  return { roots: registryTree, source: 'registry' };
}

/** name -> direct dependency names, read from whichever lockfile exists. */
type ForwardGraph = Map<string, string[]>;

/** Normalises a package name into the form its ecosystem's graph is keyed by. */
function graphKey(name: string, ecosystem: Ecosystem): string {
  return ecosystem === 'python' ? normalizePythonName(name) : name;
}

async function buildForwardGraph(
  target: Dependency,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  const dir = path.dirname(target.manifestPath);

  switch (target.ecosystem) {
    case 'node':
      return buildNodeGraph(dir, ctx);
    case 'cargo':
      return buildCargoGraph(dir, ctx);
    case 'composer':
      return buildComposerGraph(dir, ctx);
    case 'python':
      return buildPythonGraph(dir, ctx);
    default:
      // Go, Maven and Gradle have no local file describing dependency *edges*:
      // go.sum lists the transitive closure with hashes but records nothing
      // about who requires whom (that needs `go mod graph`, i.e. running a
      // command), and Maven/Gradle have no lockfile at all in the general case.
      // These route to the registry path, which does carry edges.
      return undefined;
  }
}

async function buildNodeGraph(
  dir: string,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  // npm, pnpm and yarn each have their own format; try whichever is present.
  return (
    (await buildNpmLockGraph(dir, ctx)) ??
    (await buildPnpmGraph(dir, ctx)) ??
    (await buildYarnGraph(dir, ctx))
  );
}

async function buildNpmLockGraph(
  dir: string,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'package-lock.json'));
  if (!text) return undefined;

  try {
    const lock = JSON.parse(text) as {
      packages?: Record<string, { dependencies?: Record<string, string> }>;
    };
    const graph: ForwardGraph = new Map();

    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      const name = npmLockName(key);
      const children = Object.keys(entry.dependencies ?? {});
      // A package can appear at several install paths; union their edges.
      const existing = graph.get(name);
      graph.set(
        name,
        existing ? [...new Set([...existing, ...children])] : children,
      );
    }

    return graph;
  } catch {
    return undefined;
  }
}

/**
 * Turns a `packages` key from a v2/v3 npm lockfile into a graph node name.
 *
 * Three shapes appear, and only one of them mentions `node_modules`:
 *   ""                         the root project
 *   "node_modules/lodash"      an installed package
 *   "packages/web"             a workspace member
 *
 * Slicing blindly from `lastIndexOf('node_modules/')` yields an empty string
 * for that third case — every workspace member collapsing onto one nameless
 * node, with all their edges unioned together — which is exactly the monorepo
 * where "why is this installed" is worth asking.
 */
function npmLockName(key: string): string {
  if (key === '') return '__root__';

  const marker = key.lastIndexOf('node_modules/');
  if (marker >= 0) return key.slice(marker + 'node_modules/'.length);

  // A workspace member. It is a root of the graph in its own right: nothing
  // depends on it, and its dependencies are the project's own.
  return '__root__';
}

interface PnpmLockEntry {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

/**
 * pnpm-lock.yaml.
 *
 * Read with the real YAML parser rather than by indentation: `importers:`
 * shares the same 2-space-indent, colon-terminated shape as `packages:`/
 * `snapshots:`, and a hand-rolled line scanner had no way to tell them apart
 * from the text alone. Only the latter two hold the resolved dependency
 * graph — that shape is stable across lockfile versions 5–9, where the
 * surrounding schema is not.
 */
async function buildPnpmGraph(
  dir: string,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'pnpm-lock.yaml'));
  if (!text) return undefined;

  let doc: {
    packages?: Record<string, PnpmLockEntry>;
    snapshots?: Record<string, PnpmLockEntry>;
  };
  try {
    doc = (parseYaml(text) ?? {}) as typeof doc;
  } catch {
    return undefined;
  }

  const graph: ForwardGraph = new Map();

  for (const section of [doc.packages, doc.snapshots]) {
    for (const [key, entry] of Object.entries(section ?? {})) {
      const name = pnpmNameFromKey(key);
      if (!name) continue;
      if (!graph.has(name)) graph.set(name, []);

      const children = [
        ...Object.keys(entry?.dependencies ?? {}),
        ...Object.keys(entry?.optionalDependencies ?? {}),
      ];
      if (children.length === 0) continue;

      const existing = graph.get(name) ?? [];
      graph.set(name, [...new Set([...existing, ...children])]);
    }
  }

  return graph.size > 0 ? graph : undefined;
}

/** `/@scope/name@1.2.3(peer@1)` and `name@1.2.3` both reduce to the bare name. */
function pnpmNameFromKey(key: string): string | undefined {
  let rest = key.startsWith('/') ? key.slice(1) : key;
  // Drop the peer-dependency suffix pnpm appends in parentheses.
  const paren = rest.indexOf('(');
  if (paren >= 0) rest = rest.slice(0, paren);

  const at = rest.lastIndexOf('@');
  if (at <= 0) return rest || undefined;
  return rest.slice(0, at) || undefined;
}

/**
 * yarn.lock (v1 and berry).
 *
 * Blocks are separated by a blank line: a header naming one or more specs, then
 * an indented body that may contain a `dependencies:` map.
 */
async function buildYarnGraph(
  dir: string,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'yarn.lock'));
  if (!text) return undefined;

  const graph: ForwardGraph = new Map();

  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    const header = lines[0].trim();
    if (header.startsWith('#') || !header.endsWith(':')) continue;

    // The header can list several specs; they all resolve to the same package.
    const firstSpec = header
      .slice(0, -1)
      .split(',')[0]
      .trim()
      .replace(/^['"]|['"]$/g, '');
    const name = yarnNameFromSpec(firstSpec);
    if (!name) continue;

    const children: string[] = [];
    let inDependencies = false;

    for (const line of lines.slice(1)) {
      const trimmed = line.trim().replace(/^['"]|['"]$/g, '');
      if (/^(dependencies|optionalDependencies):$/.test(trimmed)) {
        inDependencies = true;
        continue;
      }
      // A non-indented-enough key ends the block.
      if (inDependencies && line.search(/\S/) <= 2) {
        inDependencies = false;
      }
      if (inDependencies) {
        const child = trimmed.split(/[:\s]/)[0].replace(/^['"]|['"]$/g, '');
        if (child) children.push(child);
      }
    }

    const existing = graph.get(name);
    graph.set(
      name,
      existing ? [...new Set([...existing, ...children])] : children,
    );
  }

  return graph.size > 0 ? graph : undefined;
}

/** `lodash@^4.17.0` and `@scope/pkg@npm:^1.0.0` both reduce to the bare name. */
function yarnNameFromSpec(spec: string): string | undefined {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return spec || undefined;
  return spec.slice(0, at) || undefined;
}

/**
 * poetry.lock and uv.lock.
 *
 * Both are TOML arrays of `[[package]]` tables. Poetry nests requirements under
 * `[package.dependencies]`, uv under a `dependencies = [{ name = "..." }]`
 * array — so the two are split apart here rather than pretending they match.
 */
async function buildPythonGraph(
  dir: string,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  for (const lockName of ['uv.lock', 'poetry.lock']) {
    const text = await ctx.readFile(path.join(dir, lockName));
    if (!text) continue;

    const graph: ForwardGraph = new Map();

    for (const block of splitTomlPackageBlocks(text)) {
      const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
      if (!name) continue;

      const children = new Set<string>();

      // uv: dependencies = [{ name = "x" }, ...]
      const uvArray = /\ndependencies\s*=\s*\[([\s\S]*?)\n\]/.exec(block)?.[1];
      if (uvArray) {
        for (const match of uvArray.matchAll(/name\s*=\s*"([^"]+)"/g)) {
          children.add(normalizePythonName(match[1]));
        }
      }

      // poetry: [package.dependencies] followed by `key = "constraint"` lines,
      // ending at the next table header.
      const poetryTable =
        /\n\[package\.dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(block)?.[1];
      if (poetryTable) {
        for (const line of poetryTable.split(/\r?\n/)) {
          const key = /^([A-Za-z0-9._-]+)\s*=/.exec(line.trim())?.[1];
          if (key) children.add(normalizePythonName(key));
        }
      }

      graph.set(normalizePythonName(name), [...children]);
    }

    if (graph.size > 0) return graph;
  }

  return undefined;
}

/**
 * Splits a TOML document into its `[[package]]` block bodies.
 *
 * Splitting on the header text alone would silently drop the first package in a
 * file that opens with `[[package]]` and no preamble, so the boundaries are
 * taken from the match positions instead.
 */
function splitTomlPackageBlocks(text: string): string[] {
  const headers = [...text.matchAll(/(?:^|\n)\[\[package\]\][^\n]*\n/g)];
  return headers.map((header, index) => {
    const start = header.index! + header[0].length;
    const end =
      index + 1 < headers.length ? headers[index + 1].index! : text.length;
    return text.slice(start, end);
  });
}

async function buildCargoGraph(
  dir: string,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'Cargo.lock'));
  if (!text) return undefined;

  try {
    // Parsed with a light regex rather than a TOML parse: Cargo.lock is a flat
    // sequence of [[package]] tables and this avoids a second parser pass.
    const graph: ForwardGraph = new Map();

    for (const block of splitTomlPackageBlocks(text)) {
      const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
      if (!name) continue;
      const depsBlock =
        /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? '';
      const children = [...depsBlock.matchAll(/"([^"\s]+)/g)].map(
        (match) => match[1].split(' ')[0],
      );
      graph.set(name, children);
    }

    return graph;
  } catch {
    return undefined;
  }
}

async function buildComposerGraph(
  dir: string,
  ctx: ProviderContext,
): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'composer.lock'));
  if (!text) return undefined;

  try {
    const lock = JSON.parse(text) as {
      packages?: Array<{ name: string; require?: Record<string, string> }>;
      'packages-dev'?: Array<{
        name: string;
        require?: Record<string, string>;
      }>;
    };
    const graph: ForwardGraph = new Map();
    for (const entry of [
      ...(lock.packages ?? []),
      ...(lock['packages-dev'] ?? []),
    ]) {
      graph.set(
        entry.name,
        Object.keys(entry.require ?? {}).filter(
          (name) => name !== 'php' && !name.startsWith('ext-'),
        ),
      );
    }
    return graph;
  } catch {
    return undefined;
  }
}

/**
 * Walks the graph backwards from `target` to every package that requires it,
 * then returns those chains root-first.
 */
function tracePaths(graph: ForwardGraph, target: string): DepNode[] {
  // Invert once; a package can have many dependents.
  const reverse = new Map<string, string[]>();
  for (const [parent, children] of graph) {
    for (const child of children) {
      const list = reverse.get(child);
      if (list) list.push(parent);
      else reverse.set(child, [parent]);
    }
  }

  if (!reverse.has(target)) return [];

  const chains: string[][] = [];
  /** True when the budget stopped the walk, so the UI can say the tree is partial. */
  let truncated = false;

  /*
   * Depth-first walk up the reverse edges, collecting each distinct chain.
   *
   * The budget is checked *inside* the recursion, not applied to the finished
   * list. This enumerates simple paths, so its cost is the product of the
   * branching factors rather than their sum: a widely-depended-on package in a
   * real lockfile can have tens of parents at each of eight levels, and
   * collecting every path before truncating to 40 would occupy the extension
   * host — which is single-threaded, and shared with the editor — for minutes.
   */
  const walk = (name: string, chain: string[], visited: Set<string>) => {
    if (chains.length >= MAX_CHAINS) {
      truncated = true;
      return;
    }
    if (chain.length > MAX_DEPTH) {
      chains.push([...chain]);
      truncated = true;
      return;
    }
    const parents = reverse.get(name);
    if (!parents || parents.length === 0 || name === '__root__') {
      chains.push([...chain]);
      return;
    }
    // When every parent is already on the current path we are inside a cycle.
    // The chain built so far is still the honest answer, so record it rather
    // than returning nothing and making a cyclic graph look like no graph.
    let advanced = false;

    for (const parent of parents) {
      if (chains.length >= MAX_CHAINS) {
        truncated = true;
        return;
      }
      if (visited.has(parent)) continue; // cycle guard
      advanced = true;
      if (parent === '__root__') {
        chains.push([...chain]);
        continue;
      }
      visited.add(parent);
      walk(parent, [parent, ...chain], visited);
      visited.delete(parent);
    }

    if (!advanced) {
      chains.push([...chain]);
    }
  };

  walk(target, [target], new Set([target]));

  // Fold the chains into a tree so shared prefixes render once.
  const roots: DepNode[] = [];
  for (const chain of chains) {
    let level = roots;
    let node: DepNode | undefined;
    for (const name of chain) {
      node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = { name, children: [] };
        level.push(node);
      }
      level = node.children;
    }
    // Mark the leaf of a chain the budget cut short, so the drawer can show
    // that the answer continues past what is displayed.
    if (truncated && node && chain.length > MAX_DEPTH) {
      node.truncated = true;
    }
  }

  return roots;
}

interface DepsDevResponse {
  nodes: Array<{
    versionKey: { system: string; name: string; version: string };
    relation: 'SELF' | 'DIRECT' | 'INDIRECT';
  }>;
  edges: Array<{ fromNode: number; toNode: number; requirement?: string }>;
}

/**
 * Fallback path: ask deps.dev for the resolved graph of the *package itself*
 * and show what it pulls in. This answers "what does this bring with it",
 * which is the useful question when no local lockfile exists.
 */
async function buildFromDepsDev(
  target: Dependency,
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<DepNode[]> {
  const provider = providerFor(target.ecosystem);
  const system = provider.depsDevSystem;
  const version = target.installed ?? target.latest;
  if (!system || !version) return [];

  // deps.dev takes the package name as one URL-encoded path segment; Maven
  // coordinates keep their colon, encoded as %3A.
  const url =
    `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(target.name)}` +
    `/versions/${encodeURIComponent(version)}:dependencies`;

  try {
    const response = await ctx.http.getJson<DepsDevResponse>(url, { signal });

    // The response is an adjacency list, which may contain cycles — Go and
    // Maven graphs routinely do. Materialising it by sharing child arrays
    // would reproduce those cycles as a cyclic *object*, and `postMessage`
    // JSON-serializes: one `Converting circular structure to JSON` and the
    // whole drawer silently stays empty. So the tree is expanded by explicit
    // traversal, with the current path tracked to cut cycles.
    const edgesFrom = new Map<number, Array<{ to: number; range?: string }>>();
    for (const edge of response.edges) {
      if (edge.fromNode === edge.toNode) continue;
      const list = edgesFrom.get(edge.fromNode);
      if (list) list.push({ to: edge.toNode, range: edge.requirement });
      else
        edgesFrom.set(edge.fromNode, [
          { to: edge.toNode, range: edge.requirement },
        ]);
    }

    const expand = (
      index: number,
      depth: number,
      onPath: Set<number>,
    ): DepNode => {
      const source = response.nodes[index];
      const node: DepNode = {
        name: source.versionKey.name,
        version: source.versionKey.version,
        children: [],
      };

      if (depth >= MAX_DEPTH) {
        node.truncated = true;
        return node;
      }

      for (const edge of edgesFrom.get(index) ?? []) {
        if (!response.nodes[edge.to]) continue;
        if (onPath.has(edge.to)) {
          // A cycle: name it and stop rather than pretending it terminates.
          node.children.push({
            name: response.nodes[edge.to].versionKey.name,
            version: response.nodes[edge.to].versionKey.version,
            requestedRange: edge.range,
            children: [],
            truncated: true,
          });
          continue;
        }
        if (node.children.length >= 50) {
          node.truncated = true;
          break;
        }

        onPath.add(edge.to);
        const child = expand(edge.to, depth + 1, onPath);
        child.requestedRange = edge.range;
        node.children.push(child);
        onPath.delete(edge.to);
      }

      return node;
    };

    const selfIndex = response.nodes.findIndex(
      (node) => node.relation === 'SELF',
    );
    if (selfIndex < 0) return [];
    return [expand(selfIndex, 0, new Set([selfIndex]))];
  } catch {
    return [];
  }
}
