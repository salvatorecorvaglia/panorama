/**
 * "Why is this installed?" — reverse dependency resolution.
 *
 * Accuracy comes first, so a local lockfile is always preferred: it describes
 * the tree that actually exists on disk. deps.dev is the fallback for projects
 * with no lockfile (a fresh clone, or Maven/Gradle), where the answer is
 * necessarily "what a resolver would produce" rather than "what you have".
 */

import * as path from 'node:path';
import type { DepNode, Dependency, Ecosystem } from './types.js';
import type { ProviderContext } from '../providers/provider.js';
import { providerFor } from '../providers/registry.js';

const MAX_DEPTH = 8;

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
    case 'golang':
    default:
      // Go, Maven and Gradle have no local file describing dependency *edges*:
      // go.sum lists the transitive closure with hashes but records nothing
      // about who requires whom (that needs `go mod graph`, i.e. running a
      // command), and Maven/Gradle have no lockfile at all in the general case.
      // These route to the registry path, which does carry edges.
      return undefined;
  }
}

async function buildNodeGraph(dir: string, ctx: ProviderContext): Promise<ForwardGraph | undefined> {
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
      // "" is the root project; other keys are install paths.
      const name =
        key === ''
          ? '__root__'
          : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const children = Object.keys(entry.dependencies ?? {});
      // A package can appear at several install paths; union their edges.
      const existing = graph.get(name);
      graph.set(name, existing ? [...new Set([...existing, ...children])] : children);
    }

    return graph;
  } catch {
    return undefined;
  }
}

/**
 * pnpm-lock.yaml.
 *
 * Parsed structurally by indentation rather than with a YAML library: the
 * `packages:`/`snapshots:` section is a flat map of `name@version` keys, each
 * with an optional nested `dependencies:` map. That shape is stable across
 * lockfile versions 5–9, where the surrounding schema is not.
 */
async function buildPnpmGraph(dir: string, ctx: ProviderContext): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'pnpm-lock.yaml'));
  if (!text) return undefined;

  const graph: ForwardGraph = new Map();
  const lines = text.split(/\r?\n/);

  let currentPackage: string | undefined;
  let inDependencies = false;
  let dependencyIndent = 0;

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // A package entry sits at indent 2 and ends with a colon.
    if (indent === 2 && trimmed.endsWith(':')) {
      const key = trimmed.slice(0, -1).replace(/^['"]|['"]$/g, '');
      currentPackage = pnpmNameFromKey(key);
      inDependencies = false;
      if (currentPackage && !graph.has(currentPackage)) graph.set(currentPackage, []);
      continue;
    }

    if (!currentPackage) continue;

    if (indent === 4 && (trimmed === 'dependencies:' || trimmed === 'optionalDependencies:')) {
      inDependencies = true;
      dependencyIndent = 6;
      continue;
    }
    // Any other key at the same level ends the dependency block.
    if (indent <= 4 && trimmed.endsWith(':')) {
      inDependencies = false;
      continue;
    }

    if (inDependencies && indent === dependencyIndent) {
      const name = trimmed.split(':')[0].replace(/^['"]|['"]$/g, '');
      if (name) graph.get(currentPackage)!.push(name);
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
async function buildYarnGraph(dir: string, ctx: ProviderContext): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'yarn.lock'));
  if (!text) return undefined;

  const graph: ForwardGraph = new Map();

  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    const header = lines[0].trim();
    if (header.startsWith('#') || !header.endsWith(':')) continue;

    // The header can list several specs; they all resolve to the same package.
    const firstSpec = header.slice(0, -1).split(',')[0].trim().replace(/^['"]|['"]$/g, '');
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
    graph.set(name, existing ? [...new Set([...existing, ...children])] : children);
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
      const poetryTable = /\n\[package\.dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(block)?.[1];
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

/** PEP 503 normalisation, kept local so depGraph does not depend on a provider. */
function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
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
    const end = index + 1 < headers.length ? headers[index + 1].index! : text.length;
    return text.slice(start, end);
  });
}

async function buildCargoGraph(dir: string, ctx: ProviderContext): Promise<ForwardGraph | undefined> {
  const text = await ctx.readFile(path.join(dir, 'Cargo.lock'));
  if (!text) return undefined;

  try {
    // Parsed with a light regex rather than a TOML parse: Cargo.lock is a flat
    // sequence of [[package]] tables and this avoids a second parser pass.
    const graph: ForwardGraph = new Map();

    for (const block of splitTomlPackageBlocks(text)) {
      const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
      if (!name) continue;
      const depsBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? '';
      const children = [...depsBlock.matchAll(/"([^"\s]+)/g)].map((match) => match[1].split(' ')[0]);
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
      'packages-dev'?: Array<{ name: string; require?: Record<string, string> }>;
    };
    const graph: ForwardGraph = new Map();
    for (const entry of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) {
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

  // Depth-first walk up the reverse edges, collecting each distinct chain.
  const walk = (name: string, chain: string[], visited: Set<string>) => {
    if (chain.length > MAX_DEPTH) {
      chains.push([...chain]);
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
  for (const chain of chains.slice(0, 40)) {
    let level = roots;
    for (const name of chain) {
      let node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = { name, children: [] };
        level.push(node);
      }
      level = node.children;
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

  const name = encodeDepsDevName(target.name, target.ecosystem);
  const url =
    `https://api.deps.dev/v3/systems/${system}/packages/${name}` +
    `/versions/${encodeURIComponent(version)}:dependencies`;

  try {
    const response = await ctx.http.getJson<DepsDevResponse>(url, { signal });

    const nodes = response.nodes.map((node) => ({
      name: node.versionKey.name,
      version: node.versionKey.version,
      children: [] as DepNode[],
      relation: node.relation,
    }));

    for (const edge of response.edges) {
      const from = nodes[edge.fromNode];
      const to = nodes[edge.toNode];
      if (!from || !to || from === to) continue;
      if (from.children.length < 50) {
        from.children.push({
          name: to.name,
          version: to.version,
          requestedRange: edge.requirement,
          children: to.children,
        });
      }
    }

    const self = nodes.find((node) => node.relation === 'SELF');
    if (!self) return [];
    return [{ name: self.name, version: self.version, children: self.children }];
  } catch {
    return [];
  }
}

/** deps.dev expects Maven coordinates colon-joined and everything URL-encoded. */
function encodeDepsDevName(name: string, ecosystem: Ecosystem): string {
  void ecosystem;
  return encodeURIComponent(name);
}
