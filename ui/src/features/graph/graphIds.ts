import type { CommitNode, CommitEdge } from "../../api/client";


/**
 * Collapse/expand of long linear commit chains.
 *
 * Heuristic (tunable): a maximal run of consecutive commits where each commit
 * has exactly one parent AND one child *within the loaded graph*, carries no
 * ref/tag/HEAD badge, is not a merge or branch point, and isn't the selected
 * commit, is "foldable". Runs of length >= COLLAPSE_THRESHOLD are collapsed by
 * default into a single summary node ("N commits"); the user can expand any run.
 *
 * This is a pure client-side view transform over the already-loaded graph — no
 * server involvement.
 */

export const COLLAPSE_THRESHOLD = 8;

/** Synthetic id for a collapsed run summary node. Stable = first..last oid. */
export const collapsedRunId = (headOid: string, tailOid: string) =>
  `__run__${headOid}__${tailOid}`;
/**
 * True for any summary-node id: legacy linear runs (`__run__`) and branch
 * rollups (`__branch__`), plus the Round-3 on-demand contiguous-region nodes
 * (`__region__`). Used so `selectionForSummaryNode`, MiniMap coloring, and jump
 * handling treat region nodes as summary nodes too.
 */
export const isCollapsedRunId = (id: string) =>
  id.startsWith("__run__") ||
  id.startsWith("__branch__") ||
  isRegionId(id) ||
  isMergePathId(id);

/** Synthetic id for a branch "virtual squash" rollup node. */
export const branchRollupId = (branch: string) => `__branch__${branch}`;
export const isBranchRollupId = (id: string) => id.startsWith("__branch__");

// ── Round 3: on-demand contiguous-region fold ids ─────────────────────────
//
// A region's identity is keyed on the CLICKED commit's stable oid (the anchor),
// not on shifting membership boundaries. This is the fix for the inconsistent
// trunk expand/collapse (Defect 1.9): the anchor oid never moves when the graph
// shifts, so the recorded fold/expand state stays in sync with the re-detected
// region.

/** Synthetic id for a contiguous-region summary node, keyed on its anchor oid. */
export const regionRollupId = (anchorOid: string) => `__region__${anchorOid}`;
/** True for a Round-3 region summary-node id. */
export const isRegionId = (id: string) => id.startsWith("__region__");
/** Strip the `__region__` prefix to recover the anchor oid. */
export const anchorFromId = (id: string) =>
  id.startsWith("__region__") ? id.slice("__region__".length) : id;

// ── Merge secondary-path fold ids ─────────────────────────────────────────
//
// A merge's hidden secondary path is keyed on (mergeOid, parentIndex) so its
// fold identity is stable as the graph shifts — the merge oid never moves, the
// same rationale as the Round-3 region anchor (Defect 1.9). parentIndex is the
// index into `CommitNode.parents` (>= 1 for a secondary parent).

/** Synthetic id for a merge's hidden secondary-path group, keyed on the merge. */
export const mergePathId = (mergeOid: string, parentIndex: number) =>
  `__merge__${mergeOid}__${parentIndex}`;
/** True for a merge secondary-path summary-node id. */
export const isMergePathId = (id: string) => id.startsWith("__merge__");

/**
 * Parse a `mergePathId(M, k)` string back into its `(mergeOid, parentIndex)`
 * components. The id shape is `__merge__<oid>__<index>`, and because the oid is
 * a git hash (which never contains `__`) the parent index is the segment after
 * the final `__`. Returns `null` for a non-merge id or a malformed suffix. Used
 * by the wiring to rebuild `mergeSecondaryPath` groups from folded ids and to
 * key affordance metadata on the stable merge oid.
 */
export function parseMergePathId(
  id: string,
): { mergeOid: string; parentIndex: number } | null {
  if (!isMergePathId(id)) return null;
  const body = id.slice("__merge__".length);
  const sep = body.lastIndexOf("__");
  if (sep < 0) return null;
  const mergeOid = body.slice(0, sep);
  const parentIndex = Number(body.slice(sep + "__".length));
  if (!mergeOid || !Number.isInteger(parentIndex) || parentIndex < 1) return null;
  return { mergeOid, parentIndex };
}

/**
 * The ancestor closure of `roots`, INCLUSIVE of the roots themselves, walking
 * PARENT links (from a commit to its parents). Edges run parent(source) →
 * child(target), so ancestors are found by following `target → source`. The
 * walk is bounded to in-graph commits: out-of-graph roots contribute nothing,
 * every returned oid is in-graph, and `roots ∩ inGraph ⊆ result`.
 *
 * This mirrors `detectBranchRollups`' internal `ancestorsOf`, lifted to module
 * scope for reuse by the merge secondary-path helpers.
 */
export function reachableFrom(
  roots: string[],
  nodes: CommitNode[],
  edges: CommitEdge[],
): Set<string> {
  const inGraph = new Set(nodes.map((n) => n.oid));
  // child(target) → parents(sources), among in-graph commits.
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }

  const seen = new Set<string>();
  const stack = roots.filter((oid) => inGraph.has(oid)); // out-of-graph roots contribute nothing
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const p of parentsOf.get(oid) ?? []) {
      if (!seen.has(p)) stack.push(p);
    }
  }
  return seen;
}

/**
 * Best-effort merge base of two commits computed from the loaded DAG: a
 * *lowest* common ancestor of `a` and `b` over the loaded edges. A commit is a
 * common ancestor when it is reachable (via parent links) from BOTH `a` and `b`
 * (`reachableFrom` is inclusive of its roots, so `a`/`b` themselves count when
 * one is an ancestor of the other). Among the common ancestors, the *lowest*
 * are those with no in-graph child that is also a common ancestor — i.e. nothing
 * newer than them is still common.
 *
 * Returns `null` when there is no common ancestor in the loaded window (e.g. two
 * disconnected roots, or the true base scrolled out of the window). When several
 * lowest common ancestors exist (a criss-cross history), returns the newest by
 * graph order (nodes are newest-first) for determinism.
 *
 * The hide-set computation does NOT depend on this value —
 * `reachable(Pk) \ reachable(P1)` already excludes the base and everything below
 * it. `mergeBaseFromEdges` is provided for display ("branch off @ <base>") and
 * as an explicit floor assertion in tests.
 */
export function mergeBaseFromEdges(
  a: string,
  b: string,
  nodes: CommitNode[],
  edges: CommitEdge[],
): string | null {
  const fromA = reachableFrom([a], nodes, edges);
  const fromB = reachableFrom([b], nodes, edges);

  // Common ancestors: reachable from both a and b.
  const common = new Set<string>();
  for (const oid of fromA) {
    if (fromB.has(oid)) common.add(oid);
  }
  if (common.size === 0) return null;

  // In-graph child links (edges run parent(source) → child(target)).
  const inGraph = new Set(nodes.map((n) => n.oid));
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push(e.target);
  }

  // Lowest common ancestors: a common ancestor with no child that is also a
  // common ancestor (nothing newer than it is still common).
  const lcas: string[] = [];
  for (const oid of common) {
    const hasCommonChild = (childrenOf.get(oid) ?? []).some((c) =>
      common.has(c),
    );
    if (!hasCommonChild) lcas.push(oid);
  }
  if (lcas.length === 0) return null;

  // Deterministic pick: newest by graph order (nodes are newest-first).
  const order = new Map(nodes.map((n, i) => [n.oid, i]));
  lcas.sort((x, y) => (order.get(x)! - order.get(y)!));
  return lcas[0];
}

