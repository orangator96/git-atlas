import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";
import type { Run, CollapsedRunData } from "./runDetection";
import type { EffectiveGraph } from "./regionFold";
import { effectiveExpanded } from "./regionFold";
import { foldedRefsFor } from "./mergeFold";

/**
 * Every foldable-run id whose member set intersects `oids`. Used when expanding
 * a summary node so the override is seeded with ALL runs overlapping the clicked
 * group — not just the clicked id. Because a linear run's id is derived from its
 * current head/tail boundary (`__run__<head>__<tail>`), re-detection over the
 * changed node set can otherwise mint a *new* sub-run id for the still-foldable
 * remainder that isn't in the override, re-folding all but one commit (Defect 6).
 * Seeding with every overlapping id makes the whole group un-fold in one action
 * and stay un-folded across the re-render.
 */
export function runIdsOverlapping(oids: string[], runs: Run[]): string[] {
  const want = new Set(oids);
  const ids: string[] = [];
  for (const run of runs) {
    if (run.oids.some((o) => want.has(o))) ids.push(run.id);
  }
  return ids;
}

/**
 * Pure model of the graph's fold/expand resolution — the decision logic
 * extracted out of `CommitGraph.tsx` so it can be unit-tested without the DOM.
 *
 * Given the detected linear runs, the detected branch rollups, and the user's
 * force-expand (`expandedRuns`) / force-collapse (`collapsedRuns`) sets, it
 * returns the effective graph the component should render.
 *
 * A group is folded when it is NOT in the single `effectiveExpanded` set — so a
 * manual collapse authoritatively wins over a prior expand (reversible
 * round-trip, Defect 4). The effective edge set is reconciled against the FINAL
 * render-id set so no un-folded member is left parentless by the downstream
 * dangling-edge filter (Defect 5).
 */
export function resolveFoldState(
  nodes: CommitNode[],
  edges: CommitEdge[],
  linearRuns: Run[],
  branchRollups: Run[],
  expandedRuns: Set<string>,
  collapsedRuns: Set<string>,
  nodeByOid: Map<string, CommitNode>,
): EffectiveGraph {
  // Single coherent notion of "expanded": expanded unless the user re-collapsed
  // it. Used uniformly for both linear runs and branch rollups (Defect 4).
  const eff = effectiveExpanded(expandedRuns, collapsedRuns);
  const runsToCollapse = linearRuns.filter((r) => !eff.has(r.id));
  const rollupsToCollapse = branchRollups.filter((r) => !eff.has(r.id));
  const allGroups = [...rollupsToCollapse, ...runsToCollapse];
  const collapsed = applyCollapse(nodes, edges, allGroups, eff, nodeByOid);

  // Reconcile edges against the FINAL render-id set (all rendered commit oids +
  // all summary node ids). `applyCollapse` already reroutes endpoints through
  // renderId, so every effective edge endpoint is a present render id; this
  // filter is therefore a no-op safety net that guarantees no dangling edge and
  // — combined with correct rerouting — no orphaned member (Defect 5).
  const renderIds = new Set<string>([
    ...collapsed.nodes.map((n) => n.oid),
    ...collapsed.runNodes.keys(),
  ]);
  const reconciledEdges = collapsed.edges.filter(
    (e) => renderIds.has(e.source) && renderIds.has(e.target),
  );

  return { ...collapsed, edges: reconciledEdges };
}

/**
 * Pure model of the override the graph records when the user EXPANDS a summary
 * node by clicking it. Seeds the override with EVERY foldable-run id whose
 * members overlap the clicked group, so re-detection over the changed node set
 * cannot mint a new sub-run id that re-folds the remainder — the whole group
 * un-folds in one action and stays un-folded (Defect 6). The clicked id itself
 * is always included (covers branch-rollup ids, which aren't in `linearRuns`).
 */
export function expandSeed(
  clickedId: string,
  clickedOids: string[],
  linearRuns: Run[],
): Set<string> {
  const ids = new Set<string>([clickedId]);
  for (const id of runIdsOverlapping(clickedOids, linearRuns)) ids.add(id);
  return ids;
}

/**
 * No-orphan invariant checker (used by tests). Returns the oids of rendered
 * commit members that HAD a parent in the original `graph.edges` but end up with
 * no in-edge to a rendered node in the effective graph — i.e. orphaned/dangling
 * after a fold→expand round-trip (Defect 5). An empty array means the effective
 * graph is orphan-free.
 *
 * A rendered node's "in-edge" here is an effective edge whose `target` is that
 * node (edges run parent(source) → child(target), so an in-edge is the link to
 * the node's parent). Root commits (no parent in the original graph) are exempt.
 */
export function orphanedMembers(
  originalNodes: CommitNode[],
  eff: EffectiveGraph,
): string[] {
  // Which original commits had at least one parent?
  const hadParent = new Set<string>();
  for (const n of originalNodes) {
    if (n.parents.length > 0) hadParent.add(n.oid);
  }
  // Rendered commit ids (exclude summary nodes — they are synthetic).
  const renderedCommits = new Set(eff.nodes.map((n) => n.oid));
  // Which rendered ids have an in-edge (are some effective edge's target)?
  const hasInEdge = new Set<string>();
  for (const e of eff.edges) hasInEdge.add(e.target);

  const orphans: string[] = [];
  for (const oid of renderedCommits) {
    if (hadParent.has(oid) && !hasInEdge.has(oid)) orphans.push(oid);
  }
  return orphans;
}

/**
 * Produce the effective graph given which runs are expanded. Collapsed runs are
 * replaced by a single summary node; edges into/out of the run are rerouted to
 * the summary node so the DAG stays connected.
 */
export function applyCollapse(
  nodes: CommitNode[],
  edges: CommitEdge[],
  runs: Run[],
  expanded: Set<string>,
  nodeByOid: Map<string, CommitNode>,
  refsByOid?: Map<string, RefLabel[]>,
): EffectiveGraph {
  const runNodes = new Map<string, CollapsedRunData>();
  const foldedInto = new Map<string, string>();

  // For Option-A (renderAnchor / merge) folds: the set of member oids for each
  // fold, so we can suppress the phantom "merge base → merge" edge. A folded
  // secondary path's OLDEST member's parent is the merge base (the fork point),
  // which lives on the mainline OUTSIDE the fold. Naively rerouting that
  // boundary edge through `renderId` turns `base → oldestMember` into
  // `base → merge`, making the merge look like a direct child of the fork point
  // — several generations down the mainline (the "collapsed HEAD attaches to an
  // ancestor" bug). The merge is ALREADY connected to that base through its
  // first-parent chain, so this incoming boundary edge must be dropped, not
  // rerouted. We drop any edge whose TARGET is a member of a renderAnchor fold
  // but whose SOURCE is not a member of the SAME fold (i.e. an edge entering the
  // folded branch from outside/below).
  const anchorMembership = new Map<string, string>(); // member oid → fold id

  const collapsedRuns = runs.filter((r) => !expanded.has(r.id));
  for (const run of collapsedRuns) {
    // Option-A merge fold: fold members onto an EXISTING rendered commit
    // (the anchor) instead of minting a summary node. The anchor stays a
    // normal node; the boundary edge reroutes onto it via `renderId` and the
    // resulting self-loop is dropped by the `s === t` guard below.
    if (run.renderAnchor) {
      for (const oid of run.oids) {
        foldedInto.set(oid, run.renderAnchor);
        anchorMembership.set(oid, run.id);
      }
      continue;
    }
    const first = nodeByOid.get(run.oids[0])!; // newest
    const last = nodeByOid.get(run.oids[run.oids.length - 1])!; // oldest
    runNodes.set(run.id, {
      kind: "run",
      id: run.id,
      count: run.oids.length,
      oids: run.oids,
      firstSummary: first.summary,
      lastSummary: last.summary,
      newestTs: first.timestamp,
      oldestTs: last.timestamp,
      label: run.label,
      // Additive display metadata: refs carried by the folded members, tagged
      // head-vs-buried. Only populated when refsByOid is supplied (merge path
      // folds via renderAnchor mint no node and are handled above).
      foldedRefs: refsByOid ? foldedRefsFor(run.oids, refsByOid) : undefined,
    });
    for (const oid of run.oids) foldedInto.set(oid, run.id);
  }

  // Effective nodes: keep unfolded commits; drop folded ones (represented by run node).
  const effNodes = nodes.filter((n) => !foldedInto.has(n.oid));

  // Map an oid to its rendering id (itself, or the run node it folded into).
  // Because `foldedInto` is populated from ALL groups in this single pass, every
  // endpoint maps to its FINAL render id (a commit oid or a summary node id) —
  // so a boundary edge whose counterpart folds into a DIFFERENT group is
  // rerouted to that group's summary node rather than dropped (Defect 5).
  const renderId = (oid: string) => foldedInto.get(oid) ?? oid;

  // The final set of rendered ids (un-folded commit oids + summary node ids).
  const renderIds = new Set<string>([
    ...effNodes.map((n) => n.oid),
    ...runNodes.keys(),
  ]);

  // Rebuild edges through run nodes, dropping intra-run edges and duplicates.
  const seen = new Set<string>();
  const effEdges: CommitEdge[] = [];
  for (const e of edges) {
    // Suppress the phantom "merge base → merge" edge. For an Option-A merge
    // fold, the OLDEST folded member's parent is the merge base (fork point),
    // an outside/mainline node. Rerouting that boundary edge through `renderId`
    // would produce `base → merge`, making the merge render as a direct child
    // of the fork point (pulled down several generations to just above the
    // branch point) instead of at the mainline tip where it was actually
    // merged. The merge is already linked to that base via its first-parent
    // chain, so drop any edge ENTERING a folded merge member from a node that
    // is NOT a member of the same fold (i.e. from outside/below the branch).
    const targetFold = anchorMembership.get(e.target);
    if (targetFold && anchorMembership.get(e.source) !== targetFold) continue;

    const s = renderId(e.source);
    const t = renderId(e.target);
    if (s === t) continue; // edge internal to a collapsed run
    // Reconcile against the final render-id set: keep an edge only when BOTH
    // endpoints resolve to a rendered node. With correct rerouting above this is
    // a safety net (it never drops a legitimate boundary edge), but it keeps the
    // effective edge set self-consistent so no member is orphaned downstream.
    if (!renderIds.has(s) || !renderIds.has(t)) continue;
    const key = `${s}->${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    effEdges.push({ source: s, target: t });
  }

  return { nodes: effNodes, edges: effEdges, runNodes, foldedInto };
}


