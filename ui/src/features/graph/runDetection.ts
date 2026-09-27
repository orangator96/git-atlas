import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";
import { COLLAPSE_THRESHOLD, collapsedRunId, branchRollupId } from "./graphIds";
import type { FoldedRef } from "./mergeFold";
import { mergeHideGroups, isSyncSide } from "./mergeFold";

// ── Linear-run detection ────────────────────────────────────────────────

export interface CollapsedRunData {
  kind: "run";
  id: string;
  count: number;
  /** oids folded into this node, newest-first (for expansion + info). */
  oids: string[];
  firstSummary: string; // newest commit summary in the run
  lastSummary: string; // oldest commit summary in the run
  newestTs: number;
  oldestTs: number;
  /** For branch rollups: the branch name being virtually squashed. */
  label?: string;
  /**
   * Refs carried by hidden members, tagged head-vs-buried (Requirements 16/17).
   * Populated when `applyCollapse` receives `refsByOid`; empty/undefined ⇒ no
   * folded-ref badge on the summary node.
   */
  foldedRefs?: FoldedRef[];
}

/** A detected foldable group (linear run OR branch rollup). */
export interface Run {
  oids: string[]; // newest-first, in graph order
  id: string;
  /** Optional branch-name label (present for branch rollups). */
  label?: string;
  /**
   * Option-A merge fold: an EXISTING rendered commit oid that folded members
   * map onto, instead of minting a `CollapsedRunData` summary node. When set,
   * `applyCollapse` creates no summary node for this group; every member oid is
   * routed to `renderAnchor` via `foldedInto`, so the boundary edge (e.g. the
   * merge's `Pk → M` secondary edge) reroutes onto the still-visible anchor and
   * the resulting self-loop is dropped. The anchor commit itself stays a normal
   * rendered node and MUST NOT appear in `oids`.
   */
  renderAnchor?: string;
}

/**
 * Detect foldable runs in the graph. Returns runs (length >= threshold) in
 * graph order. `refsByOid` includes HEAD/branch/tag; any presence blocks fold.
 */
export function detectRuns(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
  selectedOid: string | null,
  threshold = COLLAPSE_THRESHOLD,
): Run[] {
  const inGraph = new Set(nodes.map((n) => n.oid));

  // In-graph parent/child degree per commit.
  const childCount = new Map<string, number>(); // how many children point at it (source=parent)
  const parentCount = new Map<string, number>(); // how many parents it has in-graph
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    childCount.set(e.source, (childCount.get(e.source) ?? 0) + 1);
    parentCount.set(e.target, (parentCount.get(e.target) ?? 0) + 1);
  }

  const foldable = (oid: string): boolean => {
    if (selectedOid === oid) return false;
    if ((refsByOid.get(oid)?.length ?? 0) > 0) return false; // has a ref/tag/HEAD
    if ((parentCount.get(oid) ?? 0) !== 1) return false; // root or merge
    if ((childCount.get(oid) ?? 0) !== 1) return false; // tip or branch point
    return true;
  };

  // nodes are newest-first and topologically ordered. Group maximal consecutive
  // foldable commits that are actually chained (each one's parent is the next).
  const parentOf = new Map<string, string>(); // single in-graph parent
  for (const e of edges) {
    if (inGraph.has(e.source) && inGraph.has(e.target)) {
      // e: source=parent -> target=child; record child's parent
      parentOf.set(e.target, e.source);
    }
  }

  const runs: Run[] = [];
  let i = 0;
  const order = nodes.map((n) => n.oid);
  const indexOf = new Map(order.map((o, idx) => [o, idx]));
  while (i < order.length) {
    const oid = order[i];
    if (!foldable(oid)) {
      i++;
      continue;
    }
    // Start a run; extend while the chain stays foldable and contiguous.
    const run: string[] = [oid];
    let current = oid;
    while (true) {
      const parent = parentOf.get(current);
      if (parent && foldable(parent) && indexOf.has(parent)) {
        run.push(parent);
        current = parent;
      } else {
        break;
      }
    }
    if (run.length >= threshold) {
      runs.push({ oids: run, id: collapsedRunId(run[0], run[run.length - 1]) });
    }
    // Advance past the whole run (foldable or not, we consumed these).
    i = (indexOf.get(current) ?? i) + 1;
  }
  return runs;
}


// ── Branch "virtual squash" rollup detection ───────────────────────────

/**
 * Detect branch "virtual squash" rollups. For each collapsed branch, fold the
 * commits reachable from its tip but NOT reachable from any expanded anchor
 * (expanded branch tips / the rest of the shown graph) into a single rollup
 * group. The result plugs straight into `applyCollapse` (as `Run[]`).
 *
 * A commit currently serving as a `sync` side's introduced set (still-living
 * history pulled into a merge — `isSyncSide`) is excluded from every rollup,
 * same protection as `visibleMergeHideGroups`: a branch collapse must not
 * silently swallow commits a merge node is depending on to render its sync
 * badge.
 *
 * @param nodes           loaded commit nodes
 * @param edges           parent(source)→child(target) edges
 * @param collapsedTips   [branchName, tipOid] for each COLLAPSED branch
 * @param expandedTips    tip oids of EXPANDED branches (anchors we keep visible)
 */
export function detectBranchRollups(
  nodes: CommitNode[],
  edges: CommitEdge[],
  collapsedTips: { name: string; tip: string }[],
  expandedTips: string[],
): Run[] {
  const inGraph = new Set(nodes.map((n) => n.oid));
  // child(target) → parents(sources), among in-graph commits.
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }

  // Ancestors (inclusive) of a set of tips, walking first+all parents.
  const ancestorsOf = (tips: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!inGraph.has(oid) || seen.has(oid)) continue;
      seen.add(oid);
      for (const p of parentsOf.get(oid) ?? []) stack.push(p);
    }
    return seen;
  };

  // Commits kept visible by expanded branches — never fold these.
  const expandedReach = ancestorsOf(expandedTips);

  // Commits currently protected as a `sync` side's introduced set (a still-
  // living line pulled into a merge — e.g. main synced into a feature). Same
  // protection as `visibleMergeHideGroups`/`isSyncSide`, applied here too:
  // this is an independent fold mechanism (collapse-by-branch-name) with no
  // other awareness of merge classification, so without this it could roll a
  // live sync side into an anonymous branch-rollup summary just as easily as
  // the merge-affordance path could fold it — same bug, different door. Not
  // currently reachable (nothing wires `collapsedTips` yet), but cheap to
  // guard now rather than rediscover this later once it is.
  const syncProtected = new Set<string>();
  for (const n of nodes) {
    if (n.parents.length < 2) continue; // not a merge
    for (const group of mergeHideGroups(n.oid, nodes, edges)) {
      if (!isSyncSide(n, group.parentIndex)) continue;
      for (const oid of group.oids) syncProtected.add(oid);
    }
  }

  // Order lookup (newest-first) so each rollup's oids stay in graph order.
  const orderIndex = new Map(nodes.map((n, i) => [n.oid, i]));

  const rollups: Run[] = [];
  // Track commits already claimed by an earlier (more-recent) collapsed branch
  // so two collapsed branches sharing history don't double-fold.
  const claimed = new Set<string>();

  for (const { name, tip } of collapsedTips) {
    if (!inGraph.has(tip)) continue;
    const branchReach = ancestorsOf([tip]);
    const unique = [...branchReach].filter(
      (oid) =>
        !expandedReach.has(oid) && !claimed.has(oid) && !syncProtected.has(oid),
    );
    if (unique.length < 2) continue;
    unique.sort((a, b) => (orderIndex.get(a)! - orderIndex.get(b)!)); // newest-first
    for (const oid of unique) claimed.add(oid);
    rollups.push({ oids: unique, id: branchRollupId(name), label: name });
  }
  return rollups;
}


