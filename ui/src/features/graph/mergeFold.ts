import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";
import { reachableFrom, mergeBaseFromEdges, mergePathId } from "./graphIds";

/** Classification of a merge commit's parents for secondary-path folding. */
export interface MergeParents {
  mergeOid: string;
  firstParent: string; // P1 — mainline continuation
  secondaryParents: string[]; // P2..Pn — merged-in tips, in parent order
}

/**
 * A hidden secondary path behind a merge, keyed on (mergeOid, parentIndex).
 * The hide set is a SUB-DAG (branch-shaped), not necessarily a linear chain.
 */
export interface MergeHideSet {
  mergeOid: string;
  parentIndex: number; // index into CommitNode.parents (>= 1)
  secondaryParent: string; // the Pk this path descends from
  oids: string[]; // hidden commits, newest-first in graph order
  mergeBase: string | null; // merge_base(P1, Pk); the floor (stays visible)
}

/**
 * The hide set for one secondary parent of a merge: the commits reachable from
 * `Pk = parents[parentIndex]` but NOT reachable from the first parent
 * `P1 = parents[0]`.
 *
 *   hide(M, k) = reachable(Pk) \ reachable(P1)
 *
 * By construction `P1` and all of its ancestors are excluded (they are in
 * `reachable(P1)`), and the merge `M` itself is never a member (it stays visible
 * as the expand point) — guarded explicitly. `Pk` is included iff it was not
 * already merged into the mainline (i.e. `Pk ∉ reachable(P1)`). The result is a
 * SUB-DAG (branch-shaped, possibly containing inner merges), ordered newest-first
 * by graph order (nodes are newest-first / topological).
 *
 * Returns `null` when `mergeOid` is out-of-graph, `parentIndex` is not a valid
 * secondary parent (`< 1` or `>= parents.length`), `Pk` is not an in-graph
 * commit, or the hide set is empty (nothing unique to this side — e.g. an
 * already-fully-merged parent).
 *
 * `mergeBase` is populated via `mergeBaseFromEdges(P1, Pk)` — a display/floor
 * value that does not affect the hide-set oids (`reachable(Pk) \ reachable(P1)`
 * already excludes the base and everything below it). It is `null` when no
 * common ancestor is present in the loaded window.
 */
export function mergeSecondaryPath(
  mergeOid: string,
  parentIndex: number,
  nodes: CommitNode[],
  edges: CommitEdge[],
): MergeHideSet | null {
  const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
  const merge = nodeByOid.get(mergeOid);
  if (!merge) return null; // merge out-of-graph
  if (parentIndex < 1 || parentIndex >= merge.parents.length) return null; // not a secondary parent

  const firstParent = merge.parents[0];
  const secondaryParent = merge.parents[parentIndex];
  if (!nodeByOid.has(secondaryParent)) return null; // Pk not an in-graph commit

  const fromP1 = reachableFrom([firstParent], nodes, edges);
  const fromPk = reachableFrom([secondaryParent], nodes, edges);

  // hide(M,k) = reachable(Pk) \ reachable(P1). The set difference automatically
  // excludes P1 and all its ancestors; guard the merge itself so M is never a
  // member even in a degenerate graph.
  const hide = new Set<string>();
  for (const oid of fromPk) {
    if (oid === mergeOid) continue; // M stays visible as the expand point
    if (fromP1.has(oid)) continue; // reachable from P1 → excluded (base + mainline)
    hide.add(oid);
  }
  if (hide.size === 0) return null; // nothing unique to this side

  // Order newest-first by graph order (nodes are newest-first, topological) —
  // same ordering approach as regionAround / detectBranchRollups.
  const oids = nodes.map((n) => n.oid).filter((o) => hide.has(o));

  return {
    mergeOid,
    parentIndex,
    secondaryParent,
    oids,
    // Display / floor value only — does NOT affect the hide-set oids above.
    // Null when the true base is out of the loaded window (under-hide, never
    // orphan).
    mergeBase: mergeBaseFromEdges(firstParent, secondaryParent, nodes, edges),
  };
}

/**
 * All secondary-path hide sets for a merge — one per secondary parent with a
 * non-empty hide set. Iterates `parentIndex` from `1..parents.length-1` and
 * collects the non-null `mergeSecondaryPath` results, so an octopus merge with
 * `n` parents yields up to `n-1` independently collapsible groups. Returns `[]`
 * when `mergeOid` is out-of-graph or is not a merge (fewer than 2 parents).
 */
export function mergeHideGroups(
  mergeOid: string,
  nodes: CommitNode[],
  edges: CommitEdge[],
): MergeHideSet[] {
  const merge = nodes.find((n) => n.oid === mergeOid);
  if (!merge || merge.parents.length < 2) return []; // out-of-graph or not a merge

  const groups: MergeHideSet[] = [];
  for (let k = 1; k < merge.parents.length; k++) {
    const set = mergeSecondaryPath(mergeOid, k, nodes, edges);
    if (set) groups.push(set);
  }
  return groups;
}

/**
 * Compute the DEFAULT-view fold seed: which merges' secondary paths are folded
 * on load. A "line" is shown only when its tip is a LEAF frontier — a LOCAL
 * branch tip or HEAD that is NOT reachable from any OTHER local tip / HEAD.
 * Remote-tracking refs and tags are NOT counted as "other tips" (so a branch
 * caught up with its remote doesn't collapse itself, and fetching doesn't cause
 * flicker). Everything reachable from another local tip is "already merged" and
 * is folded behind its merge node's secondary-path hide set.
 *
 * Algorithm (Property 4 / design §leafTipVisibility):
 *   1. Candidate tips = oids of local branch tips (`kind === "branch"`) + HEAD
 *      (`is_head` / `kind === "head"`); `remotebranch` and `tag` are ignored.
 *   2. `leafTips` = candidate tips whose oid is NOT reachable from any OTHER
 *      candidate tip (i.e. not an ancestor of another local tip / HEAD). A lone
 *      candidate tip is trivially a leaf (no other tip to be reachable from).
 *   3. For every merge `M` and each secondary parent, fold its hide set — add
 *      `mergePathId(M, k)` — iff none of the hide set's members is a leaf tip;
 *      leave it expanded when any member is a leaf tip (that line stays open).
 *
 * Returns the set of `mergePathId(M, k)` strings to fold by default.
 */
export function leafTipVisibility(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refs: RefLabel[],
): Set<string> {
  const inGraph = new Set(nodes.map((n) => n.oid));

  // 1. Candidate tips: local branches + HEAD; remote-tracking refs and tags are
  //    excluded entirely from the "other tip" comparison.
  const candidateTips = new Set<string>();
  for (const r of refs) {
    if (r.kind === "branch" || r.kind === "head" || r.is_head) {
      if (inGraph.has(r.oid)) candidateTips.add(r.oid);
    }
  }

  // 2. leafTips = candidate tips not reachable from any OTHER candidate tip. A
  //    lone tip has no "other tips", so `reachableFrom([])` is empty → it's a
  //    leaf.
  const tips = [...candidateTips];
  const leafTips = new Set<string>();
  for (const t of tips) {
    const others = tips.filter((o) => o !== t);
    const fromOthers = reachableFrom(others, nodes, edges);
    if (!fromOthers.has(t)) leafTips.add(t);
  }

  // 3. For every merge, fold each secondary path whose hide set contains no leaf
  //    tip; leave paths whose hide set includes a leaf tip expanded. A `sync`
  //    side (its line continues past the merge — server-classified) is NEVER
  //    auto-folded: hiding it would tuck away still-living history (e.g. main
  //    synced into a feature), which is nonsensical.
  const toFold = new Set<string>();
  for (const n of nodes) {
    if (n.parents.length < 2) continue; // not a merge
    for (const group of mergeHideGroups(n.oid, nodes, edges)) {
      if (isSyncSide(n, group.parentIndex)) continue; // don't fold a living line
      const hasLeaf = group.oids.some((o) => leafTips.has(o));
      if (!hasLeaf) toFold.add(mergePathId(group.mergeOid, group.parentIndex));
    }
  }
  return toFold;
}

/**
 * Whether a merge's secondary parent is a `sync` side — its line continues past
 * the merge into still-living history (server-classified in `CommitNode.
 * merge_sides`). A sync side is not foldable: hiding it would tuck away mainline
 * commits. Defaults to `false` (integration / foldable) when no classification
 * is present, preserving the pre-classification behavior for older payloads.
 */
export function isSyncSide(node: CommitNode, parentIndex: number): boolean {
  return (node.merge_sides ?? []).some(
    (s) => s.parent_index === parentIndex && s.kind === "sync",
  );
}

/**
 * Recursion (Property 3 / Requirement 4): the hide groups that should be
 * OFFERED right now, given which secondary paths are currently FOLDED.
 *
 * A hidden secondary path is a sub-DAG that may contain inner merges. While an
 * enclosing path is folded, its inner merges are NOT rendered (they are members
 * of the enclosing hide set), so they must not offer their own affordance
 * (4.1). When the enclosing path is expanded, those inner merges become visible
 * and — because `mergeHideGroups` is per-merge and stateless — re-running it
 * over the current node set naturally surfaces their own hide sets (4.2, 4.3).
 *
 * This helper makes that contract explicit and pure: it re-runs
 * `mergeHideGroups` for every in-graph merge, but SKIPS any merge whose oid is
 * hidden behind a currently-folded path. `foldedPathIds` is the set of
 * `mergePathId(M, k)` strings that are folded right now (a subset of what the
 * UI records in its fold state). The result is the flat list of hide groups
 * that should currently show an affordance — inner merges appear in it exactly
 * when their enclosing path is expanded.
 *
 * Recursion is therefore *inherent* in the stateless per-merge design; this
 * function only encodes "don't offer a control for a merge you can't see yet"
 * so the caller (CommitGraph wiring, task 6) stays trivial and the recursion
 * contract is directly unit-testable.
 */
export function visibleMergeHideGroups(
  nodes: CommitNode[],
  edges: CommitEdge[],
  foldedPathIds: Set<string>,
): MergeHideSet[] {
  // Which commits are currently hidden behind a folded secondary path? A merge
  // whose oid is in this set is not rendered, so it offers no affordance.
  const hidden = new Set<string>();
  for (const n of nodes) {
    if (n.parents.length < 2) continue; // not a merge
    for (const group of mergeHideGroups(n.oid, nodes, edges)) {
      if (foldedPathIds.has(mergePathId(group.mergeOid, group.parentIndex))) {
        for (const oid of group.oids) hidden.add(oid);
      }
    }
  }

  // Offer hide groups only for merges that are themselves visible (not hidden
  // behind a folded enclosing path), AND only for `integration` sides. A
  // `sync` side's line continues past the merge into still-living history
  // (e.g. main synced into a feature), so it gets the non-foldable "synced N
  // from X" badge instead (MergeNodeComponent, driven by `syncSides`, computed
  // by the caller from the same `merge_sides` classification). It must NOT
  // also appear here: a sync parent showing both the sync badge AND a manual
  // fold affordance is a contradictory, doubled-up render of the same
  // secondary parent, and folding a still-living line is nonsensical
  // regardless of who triggers the fold. `leafTipVisibility`'s own
  // `isSyncSide` skip (for the auto-fold seed) is now redundant for sync sides
  // specifically since they never reach this list at all, but it's left in
  // place as a harmless no-op guard.
  const visible: MergeHideSet[] = [];
  for (const n of nodes) {
    if (n.parents.length < 2) continue; // not a merge
    if (hidden.has(n.oid)) continue; // merge is itself folded away
    for (const group of mergeHideGroups(n.oid, nodes, edges)) {
      if (isSyncSide(n, group.parentIndex)) continue; // sync → badge, not affordance
      visible.push(group);
    }
  }
  return visible;
}

/**
 * A ref carried by a commit hidden inside a fold, tagged with where it sits.
 * `buried === false` → the ref is on the fold's head member (`oids[0]`, the
 * newest / tip of the group); `buried === true` → it is carried by an interior
 * (non-head) member. Used so a folded branch/remote-branch/tag never silently
 * disappears — it resurfaces as a badge on the summary node, styled head-vs-
 * buried (Requirements 16/17).
 */
export interface FoldedRef {
  ref: RefLabel;
  buried: boolean;
}

/**
 * Collect the refs carried by a group's member commits, tagged head-vs-buried.
 * `oids` is the group's ordered members, newest-first, so `oids[0]` is the head
 * member: a ref on `oids[0]` is head (`buried:false`) and a ref on any later
 * member is buried (`buried:true`). Emits one `FoldedRef` per (member, ref) pair,
 * preserving member order then ref order, and returns `[]` when no member carries
 * a ref (Requirement 16.4). Pure and DOM-free.
 */
export function foldedRefsFor(
  oids: string[],
  refsByOid: Map<string, RefLabel[]>,
): FoldedRef[] {
  const out: FoldedRef[] = [];
  oids.forEach((oid, index) => {
    for (const ref of refsByOid.get(oid) ?? []) {
      out.push({ ref, buried: index > 0 });
    }
  });
  return out;
}

/**
 * Parse the branch/ref name that a merge commit's SUMMARY records as merged in.
 * Git's default merge messages name the source explicitly, so this is the most
 * authoritative "what merged in" signal for a secondary path — more reliable
 * than scanning the hide set for refs, since a ref buried in the merged-in
 * branch's history (e.g. `demo-feature` sitting on a commit main absorbed long
 * ago) is NOT the branch that merged in here.
 *
 * Recognised shapes (git's own wording):
 *   - `Merge branch 'X'`                         → X
 *   - `Merge branch 'X' into Y`                  → X  (X is the source)
 *   - `Merge remote-tracking branch 'origin/X'`  → origin/X
 *   - `Merge tag 'X'`                            → X
 *   - `Merge pull request #12 from user/X`       → user/X
 *
 * Returns null when the summary doesn't match a known pattern (e.g. a squash or
 * hand-written merge subject), so the caller can fall back.
 */
export function mergedBranchName(summary: string): string | null {
  // `Merge branch 'X'` / `... 'X' into Y` / `Merge remote-tracking branch 'X'`
  // / `Merge tag 'X'` — the quoted token is the source that merged in.
  const quoted = summary.match(
    /^Merge (?:remote-tracking )?(?:branch|tag) '([^']+)'/,
  );
  if (quoted) return quoted[1];
  // `Merge pull request #N from owner/branch` — take the ref after `from`.
  const pr = summary.match(/^Merge pull request #\d+ from (\S+)/);
  if (pr) return pr[1];
  return null;
}

/**
 * The best available name for the branch that merged in on a secondary path,
 * in priority order:
 *   1. the merge summary's recorded source (`mergedBranchName`) — git's own
 *      record of what was merged, immune to the merged-in branch's tip moving on;
 *   2. a branch / remote-branch ref pointing EXACTLY at the secondary parent Pk
 *      (the tip that was merged, when it hasn't advanced past the merge);
 *   3. the head (non-buried) ref carried anywhere on the hidden path, else its
 *      first ref — the loosest signal, used only when 1 and 2 give nothing.
 * Returns null when no name can be determined. Pure and DOM-free.
 */
export function mergedFromName(
  mergeSummary: string,
  secondaryParent: string,
  foldedRefs: FoldedRef[],
  refsByOid: Map<string, RefLabel[]>,
): string | null {
  const fromMessage = mergedBranchName(mergeSummary);
  if (fromMessage) return fromMessage;
  const tipRef = (refsByOid.get(secondaryParent) ?? []).find(
    (r) => r.kind === "branch" || r.kind === "remotebranch",
  );
  if (tipRef) return tipRef.name;
  const head = foldedRefs.find((fr) => !fr.buried)?.ref.name;
  return head ?? foldedRefs[0]?.ref.name ?? null;
}

