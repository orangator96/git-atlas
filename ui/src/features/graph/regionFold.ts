import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";
import { regionRollupId } from "./graphIds";
import type { CollapsedRunData, Run } from "./runDetection";

// ─────────────────────────────────────────────────────────────────────────
// Round 3: on-demand contiguous-region collapse model.
//
// The atomic fold unit is the maximal *contiguous chain* of foldable commits
// around a chosen anchor commit, bounded by (and EXCLUDING) the nearest branch
// point below and the nearest merge point above. Because such a region is a
// single chain with exactly one entry edge and one exit edge, folding it via
// `applyCollapse` is inherently orphan-free (Defect 1.8 becomes structurally
// impossible). Every eligible commit (region of >= 2 members) can be folded on
// demand (Defect 1.10), and the fold identity is keyed on the anchor's stable
// oid (Defect 1.9). This supersedes `detectRuns`/`detectBranchRollups` AS THE
// FOLD MECHANISM (branch rollups remain only for server-ref scoping).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pre-computed topological adjacency over an in-graph node set — the maps that
 * `regionAround` needs to decide foldability, plus the ordered oid list used to
 * emit region members newest-first.
 *
 * Built ONCE per (nodes, edges, refsByOid) via {@link buildAdjacency} and
 * threaded through the per-node region scans (`foldableNodeIds`,
 * `autoCollapseAnchors`, `regionsFromAnchors`). This is what makes those scans
 * O(N + E) instead of O(N²): previously each `regionAround` call rebuilt these
 * maps (an O(N + E) sweep) inside an O(N) loop. The maps are read-only — the
 * commit graph is immutable for a given node set — so sharing one instance
 * across every call in a pass is safe.
 */
export interface Adjacency {
  /** Every in-graph oid, for O(1) membership tests. */
  inGraph: Set<string>;
  /** oid → number of in-graph children (edges run parent(source)→child(target)). */
  childCount: Map<string, number>;
  /** oid → number of in-graph parents. */
  parentCount: Map<string, number>;
  /** child.target → its single in-graph parent (last writer wins; only meaningful when parentCount === 1). */
  parentOf: Map<string, string>;
  /** parent.source → its single in-graph child (last writer wins; only meaningful when childCount === 1). */
  childOf: Map<string, string>;
  /** oids carrying the checked-out HEAD (never foldable / never region members). */
  headOids: Set<string>;
  /** All in-graph oids in graph order (newest-first, topological). */
  order: string[];
}

/**
 * Build the shared {@link Adjacency} for a node set in a single O(N + E) sweep.
 * Call this once at the top of a pass that scans many commits and pass the
 * result into {@link regionAround} so the maps are not rebuilt per call.
 */
export function buildAdjacency(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
): Adjacency {
  const inGraph = new Set(nodes.map((n) => n.oid));
  const childCount = new Map<string, number>();
  const parentCount = new Map<string, number>();
  const parentOf = new Map<string, string>();
  const childOf = new Map<string, string>();
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    childCount.set(e.source, (childCount.get(e.source) ?? 0) + 1);
    parentCount.set(e.target, (parentCount.get(e.target) ?? 0) + 1);
    parentOf.set(e.target, e.source);
    childOf.set(e.source, e.target);
  }
  const headOids = new Set<string>();
  for (const n of nodes) {
    const refs = refsByOid.get(n.oid);
    if (refs && refs.some((r) => r.is_head || r.kind === "head")) {
      headOids.add(n.oid);
    }
  }
  return {
    inGraph,
    childCount,
    parentCount,
    parentOf,
    childOf,
    headOids,
    order: nodes.map((n) => n.oid),
  };
}

/**
 * The maximal contiguous foldable chain around `oid`.
 *
 * Walks DOWN via the single in-graph first-parent while each commit is foldable
 * (stops BEFORE the nearest branch point — a commit with >= 2 children), and UP
 * via the single in-graph child while foldable (stops BEFORE the nearest merge
 * point — a commit with >= 2 parents). A commit is foldable when it has exactly
 * one in-graph parent AND one in-graph child, carries no ref/tag/HEAD, and is
 * not the selected commit.
 *
 * Returns the region's member oids newest-first, or `null` when the region has
 * fewer than 2 members (a lone commit renders as a normal node — 2.8/3.8) or
 * the anchor itself is not foldable (it's a boundary/HEAD commit).
 *
 * Foldability is purely topological plus the HEAD carve-out — selection is NOT
 * a region boundary (Property 11): the selected commit is treated exactly like
 * any other commit, so the region set is invariant across different selections
 * and the selected commit keeps its fold control.
 *
 * PERFORMANCE: pass a pre-built {@link Adjacency} (`adj`) when scanning many
 * commits in a loop — that reuses one O(N + E) sweep across all calls, making
 * the loop O(N + E) instead of O(N²). When omitted, the adjacency is built
 * internally (convenient for one-off calls and to keep the original 4-arg
 * signature working for existing callers/tests).
 */
export function regionAround(
  oid: string,
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
  adj?: Adjacency,
): string[] | null {
  const { inGraph, childCount, parentCount, parentOf, childOf, headOids, order } =
    adj ?? buildAdjacency(nodes, edges, refsByOid);
  if (!inGraph.has(oid)) return null;

  // A commit carries the checked-out HEAD when its ref list has a HEAD entry
  // (`is_head` primarily; `kind === "head"` belt-and-suspenders). Precomputed
  // in `buildAdjacency` so this is an O(1) set lookup.
  const isHead = (x: string): boolean => headOids.has(x);

  const foldable = (x: string): boolean => {
    // Refs (branch/remote-branch/tag) NO LONGER block folding — they surface as
    // badges on the summary node (tasks 12/13) so nothing silently disappears.
    // Only the checked-out HEAD commit stays pinned inline, so the user's current
    // position is never hidden inside a fold. The common HEAD-at-tip case is
    // already non-foldable by the one-child rule below; this gate only bites for
    // an interior/detached HEAD (one parent AND one child).
    //
    // Selection is likewise NOT a boundary (Property 11): the selected commit is
    // foldable like any other, so the region set is invariant across selections.
    if (isHead(x)) return false;
    if ((parentCount.get(x) ?? 0) !== 1) return false; // root or merge point
    if ((childCount.get(x) ?? 0) !== 1) return false; // tip or branch point
    return true;
  };

  if (!foldable(oid)) return null; // anchor is a boundary/HEAD commit itself

  // Collect members as a set first (order fixed at the end via graph order).
  const members = new Set<string>([oid]);

  // Walk DOWN (older) via first-parent while foldable; stops before a branch point.
  let cur = oid;
  while (true) {
    const parent = parentOf.get(cur);
    if (parent && !members.has(parent) && foldable(parent)) {
      members.add(parent);
      cur = parent;
    } else break;
  }

  // Walk UP (newer) via the single child while foldable; stops before a merge point.
  cur = oid;
  while (true) {
    const child = childOf.get(cur);
    if (child && !members.has(child) && foldable(child)) {
      members.add(child);
      cur = child;
    } else break;
  }

  if (members.size < 2) return null;

  // Order newest-first by graph order (nodes are newest-first, topological).
  const ordered = order.filter((o) => members.has(o));
  return ordered;
}

/**
 * Turn a set of fold anchors into `Run[]` groups for `applyCollapse`. Each anchor
 * maps to `regionAround(anchor)`; nulls are dropped and overlapping regions are
 * de-duplicated (an anchor whose region is already covered by an earlier region
 * is skipped) so no commit is claimed by two groups. The resulting `Run.id` is
 * the anchor-keyed `regionRollupId(anchor)`.
 */
export function regionsFromAnchors(
  anchors: Iterable<string>,
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
): Run[] {
  const adj = buildAdjacency(nodes, edges, refsByOid);
  const groups: Run[] = [];
  const claimed = new Set<string>();
  for (const anchor of anchors) {
    if (claimed.has(anchor)) continue;
    const members = regionAround(anchor, nodes, edges, refsByOid, adj);
    if (!members) continue;
    // Skip if this region overlaps an already-claimed region (dedupe).
    if (members.some((o) => claimed.has(o))) continue;
    for (const o of members) claimed.add(o);
    groups.push({ oids: members, id: regionRollupId(anchor) });
  }
  return groups;
}

/**
 * Result of `foldableNodeIds`: the set of nodes that should render a fold
 * control, plus the canonical anchor each node folds its containing region from.
 */
export interface FoldableNodes {
  /** Every node oid that should render a fold control. */
  eligible: Set<string>;
  /** node oid -> canonical region anchor oid `collapseRegion` should use. */
  anchorFor: Map<string, string>;
}

/**
 * Discover every foldable region once and mark EVERY member of each ≥ 2-member
 * region as eligible for a fold control (not just the region head) AND every
 * in-lane node IMMEDIATELY ADJACENT to such a region (Req 26.3), mapping each to
 * the region's canonical anchor.
 *
 * For each node, `regionAround(node.oid, …)` returns the ordered members
 * (newest-first) of the maximal contiguous foldable region CONTAINING that node,
 * or `null` when the region has fewer than 2 members. Because the walk expands
 * both up and down from ANY starting member, `regionAround` returns the SAME
 * ordered member list for every member of a region — so choosing the canonical
 * anchor as `members[0]` (the region's newest member) is deterministic and
 * identical no matter which member seeded the lookup. Every member is added to
 * `eligible` and mapped to that canonical anchor in `anchorFor`; re-visiting a
 * member already present is idempotent (it maps to the identical anchor).
 *
 * ADJACENCY CLAUSE (Req 26.3): a region is a contiguous linear chain bounded by
 * (and EXCLUDING) two in-lane neighbors — the region head's single in-graph
 * CHILD (the node just NEWER than the region — a tip, or a branch/merge point)
 * and the region tail's single in-graph PARENT (the node just OLDER — a root or
 * branch point). Those neighbors are NOT region members (they fail the foldable
 * topology test — e.g. a tip has zero children, a root has zero parents), so
 * without this clause they'd show no control even though clicking one should
 * fold the neighboring region. Each such neighbor is marked eligible and mapped
 * to the SAME canonical anchor, so `collapseRegion(anchorFor.get(neighbor))`
 * folds the adjacent region.
 *
 * MEMBER PRIORITY (Req 27.1): region MEMBER mappings are applied FIRST for every
 * region; adjacency mappings are added only when a node has no mapping yet
 * (`!anchorFor.has(neighbor)`). So a node that heads its OWN foldable region
 * folds ITS region — never a neighbor's.
 *
 * EXCLUSIONS (Req 26.4): the checked-out HEAD_Commit is never marked eligible by
 * the adjacency clause (it stays pinned inline). Merge-hidden exclusion (Req
 * 26.8) is NOT applied here: that happens at the graph-composition layer in
 * `CommitGraph.tsx`, which subtracts merge-hidden oids from `eligible` before
 * wiring `canCollapse`.
 *
 * Purely topological and **selection-invariant** — it takes no `selectedOid`
 * (Property 11: selection is never a region boundary), so the result is
 * identical across selections. HEAD is already excluded from region membership
 * by `regionAround`'s `foldable` predicate, and a single-commit fold is never
 * offered (`regionAround` returns `null` for < 2 members).
 */
export function foldableNodeIds(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
): FoldableNodes {
  const eligible = new Set<string>();
  const anchorFor = new Map<string, string>();

  const adj = buildAdjacency(nodes, edges, refsByOid);
  const { inGraph, childOf, parentOf, headOids } = adj;

  // A commit carries the checked-out HEAD when its ref list has a HEAD entry.
  const isHead = (x: string): boolean => headOids.has(x);

  // Discover the distinct regions once (keyed by canonical anchor) so member
  // mappings can be applied for ALL regions BEFORE any adjacency mapping — this
  // guarantees member priority (Req 27.1) regardless of node iteration order.
  //
  // `regionAround` returns the SAME ordered member list for every member of a
  // region, so once a node is claimed by a discovered region we skip it — this
  // walks each region ONCE instead of once per member, keeping the scan O(N + E)
  // rather than O(N · region-length).
  const regionByAnchor = new Map<string, string[]>();
  const claimed = new Set<string>();
  for (const n of nodes) {
    if (claimed.has(n.oid)) continue;
    const members = regionAround(n.oid, nodes, edges, refsByOid, adj);
    if (!members) continue; // lone commit / boundary / HEAD → no region
    for (const m of members) claimed.add(m);
    regionByAnchor.set(members[0], members); // idempotent: same anchor => same list
  }

  // Pass 1 — members. Mark every member eligible and map to its region's
  // canonical anchor (region's newest member, members[0]).
  for (const [anchor, members] of regionByAnchor) {
    for (const m of members) {
      eligible.add(m);
      anchorFor.set(m, anchor);
    }
  }

  // Pass 2 — adjacency. For each region, mark its two immediate in-lane
  // neighbors eligible mapped to the SAME anchor, WITHOUT clobbering a node's
  // own-region mapping (members keep priority — Req 27.1) and excluding the
  // checked-out HEAD_Commit (Req 26.4).
  for (const [anchor, members] of regionByAnchor) {
    const head = members[0]; // newest member
    const tail = members[members.length - 1]; // oldest member
    // Region head's single in-graph child = the node just NEWER than the region.
    const newerNeighbor = childOf.get(head);
    // Region tail's single in-graph parent = the node just OLDER than the region.
    const olderNeighbor = parentOf.get(tail);
    for (const neighbor of [newerNeighbor, olderNeighbor]) {
      if (neighbor === undefined) continue; // no such in-graph neighbor
      if (!inGraph.has(neighbor)) continue;
      if (isHead(neighbor)) continue; // HEAD stays pinned inline (Req 26.4)
      if (anchorFor.has(neighbor)) continue; // own-region mapping wins (Req 27.1)
      eligible.add(neighbor);
      anchorFor.set(neighbor, anchor);
    }
  }

  return { eligible, anchorFor };
}

/**
 * The on-load auto-collapse seed for the contiguous-region model. Returns one
 * representative anchor oid per maximal contiguous region whose length is
 * `>= minLen`, EXCEPT any region intersecting the checked-out branch's
 * first-parent chain (the HEAD trunk — the same chain `assignLanes` pins to lane
 * 0). This keeps the mainline expanded on load while auto-folding long off-trunk
 * regions (2.13, reconciling 3.6). Manual `collapseRegion` still folds trunk
 * regions on demand — the exemption applies ONLY to this auto seed.
 */
export function autoCollapseAnchors(
  nodes: CommitNode[],
  edges: CommitEdge[],
  headOid: string | null,
  refsByOid: Map<string, RefLabel[]>,
  minLen: number,
): string[] {
  const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
  const adj = buildAdjacency(nodes, edges, refsByOid);
  const { inGraph } = adj;

  // HEAD-trunk oid set: first-parent walk from headOid via parents[0].
  const trunk = new Set<string>();
  if (headOid && inGraph.has(headOid)) {
    let cur: string | undefined = headOid;
    while (cur && inGraph.has(cur) && !trunk.has(cur)) {
      trunk.add(cur);
      cur = nodeByOid.get(cur)?.parents[0];
    }
  }

  // Enumerate maximal regions: one representative anchor per region, skipping
  // commits already covered by an emitted region.
  const anchors: string[] = [];
  const covered = new Set<string>();
  for (const n of nodes) {
    const oid = n.oid;
    if (covered.has(oid)) continue;
    const members = regionAround(oid, nodes, edges, refsByOid, adj);
    if (!members) continue;
    for (const m of members) covered.add(m);
    if (members.length < minLen) continue;
    // Exempt any region intersecting the HEAD trunk.
    if (members.some((m) => trunk.has(m))) continue;
    anchors.push(oid);
  }
  return anchors;
}

/**
 * Decide which commit the right-hand detail pane should select when the user
 * clicks a summary node (linear run or branch rollup). Returns the group's
 * newest member (`oids[0]`), or `null` when the summary node id is unknown /
 * has no members (in which case the caller should leave the selection
 * unchanged rather than clearing it silently).
 */
export function selectionForSummaryNode(
  nodeId: string,
  runNodes: Map<string, CollapsedRunData>,
): string | null {
  const data = runNodes.get(nodeId);
  if (!data || data.oids.length === 0) return null;
  return data.oids[0]; // newest member
}

export interface EffectiveGraph {
  nodes: CommitNode[];
  edges: CommitEdge[];
  /** run summary nodes to render, keyed by their synthetic id. */
  runNodes: Map<string, CollapsedRunData>;
  /** oid -> run id, for any commit folded away. */
  foldedInto: Map<string, string>;
}

/**
 * Resolve the set of summary-node ids that are currently *effectively* expanded,
 * given the user's force-expand set (`expandedRuns`) and force-collapse set
 * (`collapsedRuns`). A group counts as expanded only when the user expanded it
 * AND has not since (re-)collapsed it — so a manual collapse authoritatively
 * wins over a prior expand, making the fold→expand→collapse round-trip
 * reversible (Defect 4).
 *
 * This single predicate is meant to be used uniformly wherever the graph
 * decides whether to fold a group (`runsToCollapse`, branch-rollup assembly,
 * and the `applyCollapse` override argument), replacing the three independent —
 * and previously one-way — `expandedRuns` filters.
 */
export function effectiveExpanded(
  expandedRuns: Set<string>,
  collapsedRuns: Set<string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of expandedRuns) {
    if (!collapsedRuns.has(id)) out.add(id);
  }
  return out;
}

