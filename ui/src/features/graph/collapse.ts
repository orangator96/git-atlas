import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";
import { regionRollupId, mergePathId, parseMergePathId } from "./graphIds";
import { visibleMergeHideGroups, mergedFromName, mergeSecondaryPath, foldedRefsFor } from "./mergeFold";
import type { FoldedRef } from "./mergeFold";
import type { Run } from "./runDetection";
import { regionAround } from "./regionFold";
import type { EffectiveGraph } from "./regionFold";
import { applyCollapse } from "./foldState";

// Re-exported so every existing `from "./collapse"` import keeps working
// unchanged — this file used to contain all of the below directly; it is
// now the composition root + barrel for the split-out modules.
export * from "./graphIds";
export * from "./mergeFold";
export * from "./runDetection";
export * from "./regionFold";
export * from "./foldState";

// ─────────────────────────────────────────────────────────────────────────
// Merge-fold ⨉ Region-collapse composition (task 6.1 / 6.2).
//
// Both fold mechanisms flow through the same `applyCollapse` pass, so they
// compose in one place. The rules (design §"Coexistence with Round 3
// Region-Collapse", Properties 5 + 6):
//
//   1. Compute the MERGE folds first, from the currently effectively-folded
//      merge-path ids. Each folded `mergePathId(M, k)` becomes a group with
//      `renderAnchor = M` (Option A — no minted summary node). The union of all
//      folded hide sets is the "merge-hidden" member set `Hm`.
//   2. Region seeding/eligibility is computed ONLY over commits not in `Hm`
//      (merge precedence — Requirement 7.1/7.2/12.1): a commit hidden behind a
//      merge is not also a region candidate and offers no region control.
//   3. Both group kinds fold in ONE `applyCollapse` pass, producing one
//      EffectiveGraph. Expanding a merge path removes its members from `Hm`, so
//      they regain region candidacy on the next recompute (7.3) — this falls
//      out naturally because everything is recomputed from the effective folded
//      sets.
//
// This is the DOM-free decision core the wiring (`CommitGraph.tsx`) drives and
// the reversibility / coexistence property tests exercise directly.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// Task 8.1 — Global default-view toggle: "Active lines only" vs "Full DAG".
//
// The graph's effective folded set is composed from a DEFAULT SEED plus the
// user's own manual overrides. The seed has two independent parts:
//
//   • regionSeed — long off-trunk linear regions auto-fold (Round-3
//     `autoCollapseAnchors`). This is ALWAYS applied, in both view modes.
//   • mergeSeed  — the merge default-view leaf-tip fold (`leafTipVisibility`),
//     which folds every merged line behind its merge node. This is applied
//     ONLY in "active" mode; in "full" mode it is omitted so the full DAG shows
//     with merged branches expanded by default.
//
// Crucially (Requirement 13.3) the user's manual fold/expand overrides must
// survive a view-mode flip. They are tracked SEPARATELY from the seed
// (`userCollapsed` / `userExpanded`) and are NOT reset when `viewMode` changes.
// `composeFoldSeed` is the single pure decision that combines them:
//
//   effectiveFolded = (regionSeed ∪ activeMergeSeed ∪ userCollapsed) \ userExpanded
//
// where `activeMergeSeed = viewMode === "active" ? mergeSeed : ∅`. Because the
// user overrides are applied last and are independent of `viewMode`, a
// user-collapsed path stays folded and a user-expanded path stays expanded in
// BOTH modes — only the unoverridden (default) merge paths flip.
// ─────────────────────────────────────────────────────────────────────────

/** Which default-view mode the graph is in (Requirement 13.1/13.2). */
export type ViewMode = "active" | "full";

/**
 * Compose the effective folded-id set from the default seeds and the user's
 * manual overrides, for the given view mode. Pure and DOM-free so the
 * view-mode toggle's seed logic is unit-testable (Task 8.2).
 *
 * @param viewMode       "active" applies the merge leaf-tip seed; "full" omits it
 * @param regionSeed     Round-3 region auto-collapse anchors (always applied)
 * @param mergeSeed      merge default-view leaf-tip fold ids (`leafTipVisibility`)
 * @param userCollapsed  ids the user manually folded (applied in both modes)
 * @param userExpanded   ids the user manually expanded (win over every fold)
 *
 * @returns the set of ids to fold:
 *   (regionSeed ∪ (viewMode==="active" ? mergeSeed : ∅) ∪ userCollapsed) \ userExpanded
 *
 * A user expand authoritatively wins over any seed or manual collapse (the
 * reversible round-trip of task 6), so it is subtracted last.
 */
export function composeFoldSeed(
  viewMode: ViewMode,
  regionSeed: Iterable<string>,
  mergeSeed: Iterable<string>,
  userCollapsed: Iterable<string>,
  userExpanded: Set<string>,
): Set<string> {
  const folded = new Set<string>();
  for (const id of regionSeed) folded.add(id);
  if (viewMode === "active") {
    for (const id of mergeSeed) folded.add(id);
  }
  for (const id of userCollapsed) folded.add(id);
  // A manual expand wins over every fold source (seed or manual collapse).
  for (const id of userExpanded) folded.delete(id);
  return folded;
}

/** Affordance metadata for one merge's secondary paths, threaded to the node. */
export interface MergeAffordance {
  parentIndex: number;
  id: string; // mergePathId(M, parentIndex)
  hiddenCount: number; // commits hidden behind this path
  folded: boolean; // currently folded?
  /**
   * Refs carried by commits on this secondary path, tagged head-vs-buried by
   * `group.oids` order (Requirements 16.2/17). Empty ⇒ no folded-ref badge.
   */
  foldedRefs: FoldedRef[];
  /**
   * The name of the branch/ref that merged in on this path — from the merge's
   * own summary ("Merge branch 'X'"), else a ref on the secondary parent tip,
   * else a ref carried on the path. Null when undeterminable. This is the
   * accurate "what merged in" label; a ref merely buried in the hidden history
   * (e.g. a downstream branch the merged-in line had long absorbed) is NOT it.
   */
  mergedFrom: string | null;
}

/** Result of the composed merge + region fold resolution. */
export interface MergeRegionFold {
  /** The single effective graph after folding merge paths AND regions. */
  eff: EffectiveGraph;
  /** Union of all currently-folded merge hide-set members (`Hm`). */
  mergeHidden: Set<string>;
  /** Merge-fold groups (renderAnchor = merge oid) that were folded. */
  mergeGroups: Run[];
  /** Region groups that were folded (excludes any merge-hidden commit). */
  regionGroups: Run[];
  /**
   * Affordance metadata per merge oid: one entry per secondary parent that is
   * currently OFFERED (recursion-aware — a merge hidden behind another folded
   * path is omitted). `folded` reflects whether that path is in `foldedMergePathIds`.
   */
  affordancesByMerge: Map<string, MergeAffordance[]>;
}

/**
 * Compose the merge secondary-path folds and the Round-3 region-collapse folds
 * into one effective graph, with merge folds taking precedence.
 *
 * @param nodes                loaded commit nodes (newest-first)
 * @param edges                parent(source)→child(target) edges
 * @param refsByOid            ref badges per oid (for region foldability)
 * @param selectedOid          the selected commit. NOT used for region
 *                             foldability (Property 11 — selection is never a
 *                             region boundary); retained for the selection-follow
 *                             wiring (task 16, §3).
 * @param foldedMergePathIds   the set of `mergePathId(M,k)` currently folded
 *                             (already resolved through expand/collapse state)
 * @param regionAnchors        region fold anchors currently effective (region
 *                             oids from the auto seed + manual collapses, minus
 *                             user-expanded — resolved by the caller)
 *
 * Region anchors and members that fall inside a merge-hidden commit are dropped
 * so the two membership sets stay disjoint (Requirement 7.4).
 */
export function resolveMergeAndRegionFold(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
  selectedOid: string | null,
  foldedMergePathIds: Set<string>,
  regionAnchors: Iterable<string>,
): MergeRegionFold {
  const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
  const inGraph = new Set(nodes.map((n) => n.oid));

  // `selectedOid` is intentionally NOT consulted for region foldability
  // (Property 11 — selection is never a region boundary). It is retained on the
  // signature for the selection-follow wiring added in task 16 (§3).
  void selectedOid;

  // 1. Merge folds first. For each folded merge-path id, rebuild its hide set
  //    via `mergeSecondaryPath` and fold it onto its merge oid (renderAnchor).
  //    A stale id whose merge/hide set is absent yields no group (inert — 10.4).
  const mergeGroups: Run[] = [];
  const mergeHidden = new Set<string>();
  for (const id of foldedMergePathIds) {
    const parsed = parseMergePathId(id);
    if (!parsed) continue;
    if (!inGraph.has(parsed.mergeOid)) continue; // stale anchor → inert
    const hide = mergeSecondaryPath(
      parsed.mergeOid,
      parsed.parentIndex,
      nodes,
      edges,
    );
    if (!hide) continue; // empty / invalid → nothing to fold
    mergeGroups.push({
      oids: hide.oids,
      id,
      renderAnchor: hide.mergeOid,
    });
    for (const oid of hide.oids) mergeHidden.add(oid);
  }

  // 2. Region seeding/eligibility excludes merge-hidden commits (merge wins).
  //    Drop any region anchor that is itself merge-hidden, and drop any region
  //    group whose members intersect `Hm`, so the two memberships are disjoint.
  const regionGroups: Run[] = [];
  const regionClaimed = new Set<string>();
  for (const anchor of regionAnchors) {
    if (mergeHidden.has(anchor)) continue; // merge precedence (7.1/7.2)
    if (regionClaimed.has(anchor)) continue;
    const members = regionAround(anchor, nodes, edges, refsByOid);
    if (!members) continue;
    // Merge-hidden overlap or already-claimed overlap → skip (disjoint, 7.4).
    if (members.some((o) => mergeHidden.has(o) || regionClaimed.has(o))) continue;
    for (const o of members) regionClaimed.add(o);
    regionGroups.push({ oids: members, id: regionRollupId(anchor) });
  }

  // 3. Fold both kinds in ONE pass. Merge groups first so their renderAnchor
  //    routing is established; regions never overlap them by construction.
  //    Pass refsByOid so minted region rollups get `foldedRefs` populated.
  const eff = applyCollapse(
    nodes,
    edges,
    [...mergeGroups, ...regionGroups],
    new Set<string>(),
    nodeByOid,
    refsByOid,
  );

  // Affordance metadata: which secondary paths are OFFERED right now
  // (recursion-aware via `visibleMergeHideGroups`), with their folded state.
  const affordancesByMerge = new Map<string, MergeAffordance[]>();
  for (const group of visibleMergeHideGroups(nodes, edges, foldedMergePathIds)) {
    const id = mergePathId(group.mergeOid, group.parentIndex);
    const foldedRefs = foldedRefsFor(group.oids, refsByOid);
    const entry: MergeAffordance = {
      parentIndex: group.parentIndex,
      id,
      hiddenCount: group.oids.length,
      folded: foldedMergePathIds.has(id),
      // Refs carried by this path's hidden members, head-vs-buried by group.oids
      // order (newest-first, so oids[0] is the head member) — Req 16.2/17.
      foldedRefs,
      // Accurate "what merged in" name: the merge summary's recorded source
      // first, then a ref on the secondary parent tip, then the path's head ref.
      mergedFrom: mergedFromName(
        nodeByOid.get(group.mergeOid)?.summary ?? "",
        group.secondaryParent,
        foldedRefs,
        refsByOid,
      ),
    };
    if (!affordancesByMerge.has(group.mergeOid)) {
      affordancesByMerge.set(group.mergeOid, []);
    }
    affordancesByMerge.get(group.mergeOid)!.push(entry);
  }

  return { eff, mergeHidden, mergeGroups, regionGroups, affordancesByMerge };
}
