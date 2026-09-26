import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import type { CommitNode, RefLabel, GraphResponse, StatusSummary } from "../../api/client";
import CommitNodeComponent from "./CommitNodeComponent";
import SpecialNodeComponent from "./SpecialNodeComponent";
import RunNodeComponent from "./RunNodeComponent";
import MergeNodeComponent from "./MergeNodeComponent";
import { pickEdgePorts } from "./edgePorts";
import { estimateNodeHeight, computeRowTops, assignRows, ROW_GAP } from "./nodeLayout";
import {
  regionAround,
  foldableNodeIds,
  autoCollapseAnchors,
  isCollapsedRunId,
  isMergePathId,
  parseMergePathId,
  mergePathId,
  mergeSecondaryPath,
  mergedBranchName,
  anchorFromId,
  selectionForSummaryNode,
  leafTipVisibility,
  resolveMergeAndRegionFold,
  composeFoldSeed,
  type MergeAffordance,
  type ViewMode,
} from "./collapse";

interface CommitGraphProps {
  graph: GraphResponse;
  status?: StatusSummary | null;
  selectedOid: string | null;
  onSelectCommit: (oid: string) => void;
  /**
   * Per-branch visibility. Round 3: folding is no longer driven by this — it
   * governs server-ref scoping in App.tsx (branches.ts) only, and is retained
   * here for a future BranchControl-driven per-branch fold (2.14, out of scope).
   */
  branchVisibility?: Map<string, import("./branches").BranchVisibility>;
  /** When set, center + select this commit oid (find/jump). */
  jumpToOid?: string | null;
  /** Called once a jump has been handled, so the parent can clear it. */
  onJumpConsumed?: () => void;
  /**
   * Merge-fold view mode, lifted to App.tsx so the "Collapse merged branches"
   * switch can live in the left scope overlay. `"active"` folds merged
   * side-branches behind their merge nodes; `"full"` expands the whole DAG.
   */
  viewMode?: ViewMode;
  /**
   * Name of the branch pinned to lane 0 (the trunk / mainline column). When
   * unset, defaults to `main`, then `master`, then HEAD. Lets the user choose
   * which branch reads as the straight left spine.
   */
  trunkBranch?: string | null;
}

/** Synthetic node id for the working-tree (working + staged) pseudo-node. */
export const WORKING_NODE_ID = "__working__";
/** Synthetic node id prefix for stash nodes: `__stash__<index>`. */
export const stashNodeId = (index: number) => `__stash__${index}`;
export const isWorkingId = (id: string) => id === WORKING_NODE_ID;
export const isStashId = (id: string) => id.startsWith("__stash__");
export const stashIndexFromId = (id: string) => Number(id.slice("__stash__".length));

const nodeTypes: NodeTypes = {
  commit: CommitNodeComponent,
  special: SpecialNodeComponent,
  run: RunNodeComponent,
  merge: MergeNodeComponent,
};

/**
 * Assign each rendered item (commit OR summary/run node) a lane (column) using
 * the **leaf-seeded lane-reuse ("transit-map") model**.
 *
 * Mental model: lanes are seeded from LEAF commits (a rendered commit no
 * rendered child inherits from), NOT from refs. Walking DOWN (newest→oldest) a
 * commit passes its lane to its FIRST parent, so a leaf plus its first-parent
 * ancestry form one continuous run in one lane. A merge is a JUNCTION: its
 * non-first parents are their OWN runs in their OWN lanes (the merge draws a
 * crossing edge into them); nothing stops or folds. When two runs converge on a
 * shared ancestor (a parent already reserved a lane), the current run's lane is
 * FREED and reused by a later (lower) leaf — so lane count tracks CONCURRENT
 * runs, not total branches, and the graph never fans out unboundedly.
 *
 * Refs are LABELS, not what creates lanes: this is topology-driven. `trunkTip`
 * is an OPTIONAL readability anchor only — the run seeded from it is pinned to
 * lane 0 (so the mainline is a straight left column) by reserving lane 0 for it
 * up front. Because a run flows P1→P1, lane 0 propagates down the trunk tip's
 * first-parent chain through the SAME hand-off every other run uses — there is
 * no trunk "membership" concept and no special-casing of merges. A merge simply
 * lands in its P1's lane like any first-parent continuation. Pass `null` for
 * pure leaf-seeded layout with no lane-0 preference.
 *
 * Determinism: `order` is the caller's fixed newest-first topological order, and
 * lanes are always the lowest free column, so the layout is stable for a given
 * window (the notes' "seed leaves in fixed order" requirement is satisfied by
 * the caller ordering nodes by timestamp then oid).
 *
 * Operates over `order` (commit oids AND summary/run node ids) with `edges`
 * already rewritten to those ids, so rollup nodes are first-class.
 */
export function assignLanes(
  order: string[],
  edges: { source: string; target: string }[],
  trunkTip: string | null,
  firstParentOf: Map<string, string>,
): Map<string, number> {
  const lanes = new Map<string, number>();
  const rendered = new Set(order);

  // parent(target) → [parents], rendered-only, preserving the caller's edge
  // order so "first parent" stays consistent with `firstParentOf`.
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!rendered.has(e.source) || !rendered.has(e.target)) continue;
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }

  // Lane 0 is reserved for the trunk run when a trunk tip is given and rendered;
  // every other run then starts at lane >= 1, so the trunk stays a straight left
  // column. This is the ONLY trunk special-casing: pre-reserve lane 0 for the
  // trunk tip's run. There is NO trunk membership set and NO merge special-casing
  // in the main pass — a merge simply lands in its P1's lane (enforced by the
  // post-pass below), which is stable whether side branches are folded or not.
  const hasTrunk = trunkTip !== null && rendered.has(trunkTip);
  const minLane = hasTrunk ? 1 : 0;

  // laneBusy[i] = true while lane i is claimed by a run that has not yet reached
  // the commit it was reserved for.
  const laneBusy: boolean[] = [];
  const claimLowestFree = (): number => {
    for (let i = minLane; i < laneBusy.length; i++) {
      if (!laneBusy[i]) {
        laneBusy[i] = true;
        return i;
      }
    }
    laneBusy.push(true);
    return laneBusy.length - 1;
  };

  // reservedLane[id] = the lane a not-yet-processed commit already owns because
  // a child handed its run down to it (first-parent continuation) or because it
  // is a merge's non-first parent that opened its own run. Ensures a commit
  // reachable as a parent from several places keeps ONE lane (the first claim).
  const reservedLane = new Map<string, number>();

  // Pre-reserve lane 0 for the trunk tip's run.
  if (hasTrunk) {
    reservedLane.set(trunkTip as string, 0);
    laneBusy[0] = true;
  }

  for (const id of order) {
    let lane: number;
    if (reservedLane.has(id)) {
      // A child already handed this commit its run's lane (P1 continuation), or
      // this is the pre-reserved trunk tip (lane 0).
      lane = reservedLane.get(id)!;
    } else {
      // No child reached here first → this is a leaf (in this window). Seed a
      // fresh run in the lowest free lane.
      lane = claimLowestFree();
    }
    reservedLane.delete(id);
    lanes.set(id, lane);
    while (laneBusy.length <= lane) laneBusy.push(false);

    // Hand this commit's run DOWN to its first parent; open new runs for the
    // rest. `parentsOf` order matches the edge/first-parent convention.
    const parents = parentsOf.get(id) ?? [];
    const fp = firstParentOf.get(id);
    let firstParentKept = false;
    for (const parent of parents) {
      const alreadyReserved = reservedLane.has(parent);
      if (parent === fp && !firstParentKept) {
        if (alreadyReserved) {
          // The first parent already owns a lane (two runs converge here). If
          // THIS run is the trunk (lane 0), the trunk wins so the mainline stays
          // a straight lane-0 spine; otherwise our run ends here and frees below.
          if (lane === 0) {
            const old = reservedLane.get(parent)!;
            if (old !== 0) {
              laneBusy[old] = false;
              reservedLane.set(parent, 0);
              laneBusy[0] = true;
            }
            firstParentKept = true;
          }
          continue;
        }
        // First parent continues THIS run straight down in the SAME lane.
        reservedLane.set(parent, lane);
        firstParentKept = true;
      } else {
        if (alreadyReserved) continue; // parent already has a lane
        // A non-first parent is its own run → its own new lane (a junction).
        reservedLane.set(parent, claimLowestFree());
      }
    }

    // If this commit's run did not continue into a first parent (it's a root, or
    // its first parent already had a lane), free the lane for reuse below. Lane
    // 0 (trunk) is never freed for reuse so the mainline column stays reserved.
    if (!firstParentKept && lane !== 0) laneBusy[lane] = false;
  }

  // ── Merge → P1 lane binding (the one rule that matters for merges) ─────────
  // A merge commit must sit in the SAME lane as its first parent. In the main
  // pass a commit's lane comes from whichever CHILD reached it first, so a merge
  // whose feature-side child is folded away (or absent in this window) can drift
  // into a different lane between the collapsed and expanded views — the
  // lane-hopping. Binding the merge's lane to its P1's lane here makes it stable:
  // P1 is a single deterministic commit whose own lane does not depend on which
  // side branches are folded. We resolve in `order` (newest-first) so a chain of
  // merges settles top-down. This is intentionally the LAST word on a merge's
  // lane, overriding the child-derived value.
  for (const id of order) {
    const parents = parentsOf.get(id) ?? [];
    if (parents.length < 2) continue; // not a merge
    const fp = firstParentOf.get(id);
    if (fp === undefined) continue;
    const p1Lane = lanes.get(fp);
    if (p1Lane !== undefined) lanes.set(id, p1Lane);
  }

  return lanes;
}

// Node card is variable-height (ref badges, merge affordances, stash badges,
// folded-ref badges all grow it). Row Y positions are computed height-aware in
// `computeRowTops` (see nodeLayout.ts) so a tall card never overlaps the row
// below, while the GAP between rows stays constant (uniform parent→child
// spacing). ROW_HEIGHT remains only as the fallback row pitch used by the
// pseudo-node placement helpers when no explicit per-row Y resolver is given
// (e.g. in unit tests that work purely in grid space).
const ROW_HEIGHT = 120;
// Lane spacing must exceed the widest node card (special/run cards are up to
// 210px, commit/merge up to 200px) plus a gap, or adjacent-lane cards overlap
// on their edges. 210px max card + 30px gap = 240.
const LANE_WIDTH = 240;
const X_BASE = 24;
const Y_BASE = 24;

export interface WorkingPlacement {
  /** Lane (column) the working node occupies. */
  lane: number;
  /** Row index the working node occupies (HEAD's row − 1). */
  row: number;
  /** True when the node sits right of HEAD's lane (HEAD is not a leaf). */
  offset: boolean;
  x: number;
  y: number;
}

/**
 * Find a collision-free cell one row ABOVE a base node for a pseudo-node
 * (working tree or a stash) that "grows out of" that base. Prefers the base's
 * own lane when free (base is a leaf / that lane is empty on the row above);
 * otherwise slides RIGHT to the lowest free lane on that row so it never
 * overlaps the base's child commit(s), another branch on that row, or any
 * previously-placed pseudo-node.
 *
 * `reserved` is an in/out set of already-claimed `"lane,row"` cells (real nodes
 * are pre-seeded; each placement adds its own cell) so multiple pseudo-nodes
 * anchored above the same base (e.g. the working node + a stash both built on
 * HEAD) fan out into distinct lanes instead of stacking on top of each other.
 *
 * Pure except for the documented mutation of `reserved`. Returns null when the
 * base isn't in the rendered window.
 */
export function placeAboveBase(
  baseOid: string | null,
  rowOf: Map<string, number>,
  laneOf: Map<string, number>,
  reserved: Set<string>,
  yForRow?: (row: number) => number,
): WorkingPlacement | null {
  if (!baseOid) return null;
  const baseRow = rowOf.get(baseOid);
  if (baseRow === undefined) return null;
  const baseLane = laneOf.get(baseOid) ?? 0;
  const targetRow = baseRow - 1;

  // Lowest free lane at or to the right of the base's lane that isn't already
  // occupied by a rendered node or an earlier pseudo-node on the target row.
  let lane = baseLane;
  while (reserved.has(`${lane},${targetRow}`)) lane++;
  reserved.add(`${lane},${targetRow}`);

  // Y is height-aware when a resolver is supplied (the real graph), else falls
  // back to the fixed row pitch (grid-space unit tests).
  const y = yForRow ? yForRow(targetRow) : Y_BASE + targetRow * ROW_HEIGHT;
  return {
    lane,
    row: targetRow,
    offset: lane !== baseLane,
    x: X_BASE + lane * LANE_WIDTH,
    y,
  };
}

/** Seed a reserved-cell set from every rendered node's `"lane,row"`. */
export function reservedCellsFrom(
  rowOf: Map<string, number>,
  laneOf: Map<string, number>,
): Set<string> {
  const reserved = new Set<string>();
  for (const [id, r] of rowOf) reserved.add(`${laneOf.get(id) ?? 0},${r}`);
  return reserved;
}

/**
 * Decide where the "Working tree" pseudo-node sits. It anchors one row ABOVE
 * HEAD. In HEAD's own lane when that cell is free (HEAD is a leaf); otherwise it
 * slides RIGHT to the lowest free lane on that row so it never overlaps HEAD's
 * child commit(s) or any other branch occupying that row.
 *
 * Pure and total: given the row index of every rendered node (`rowOf`) and each
 * node's lane (`laneOf`), it returns a cell guaranteed not to collide with any
 * rendered node — the chosen (lane, row) is checked against every occupant of
 * that row. Returns null when HEAD isn't in the rendered window.
 *
 * Exported for unit testing (no DOM / React Flow needed).
 */
export function computeWorkingPlacement(
  headOid: string | null,
  rowOf: Map<string, number>,
  laneOf: Map<string, number>,
  yForRow?: (row: number) => number,
): WorkingPlacement | null {
  return placeAboveBase(headOid, rowOf, laneOf, reservedCellsFrom(rowOf, laneOf), yForRow);
}

export default function CommitGraph({
  graph,
  status,
  selectedOid,
  onSelectCommit,
  jumpToOid,
  onJumpConsumed,
  viewMode = "active",
  trunkBranch = null,
}: CommitGraphProps) {
  const refsByOid = useMemo(() => {
    const map = new Map<string, RefLabel[]>();
    for (const ref of graph.refs) {
      if (!map.has(ref.oid)) map.set(ref.oid, []);
      map.get(ref.oid)!.push(ref);
    }
    return map;
  }, [graph.refs]);

  // ── On-demand contiguous-region collapse (Round 3) + merge default view ───
  // The fold unit is a contiguous region keyed on the CLICKED commit's stable
  // oid (its anchor), OR a merge secondary path keyed on its stable merge oid
  // (`mergePathId(M, k)`). Fold/expand state is anchor-keyed so it stays
  // consistent as the graph shifts (Defect 1.9).
  //
  // The effective folded set is COMPOSED from two independent inputs so the
  // view-mode toggle (task 8) can flip the merge default seed WITHOUT discarding
  // the user's manual fold/expand state (Requirement 13.3):
  //
  //   • Default seeds — re-derived from the loaded graph on every graph change:
  //       - regionSeed: long off-trunk linear regions (`autoCollapseAnchors`),
  //         ALWAYS applied in both view modes.
  //       - mergeSeed:  the merge leaf-tip default view (`leafTipVisibility`),
  //         applied ONLY in "active" mode.
  //   • User overrides — the user's manual actions, kept SEPARATE from the
  //     seeds and NOT reset on a mere view-mode flip (only re-seeded on a graph
  //     change, like the defaults):
  //       - userCollapsed: ids the user manually folded (applied in both modes).
  //       - userExpanded:  ids the user manually expanded (win over every fold).
  //
  // `composeFoldSeed` combines them:
  //   effectiveFolded = (regionSeed ∪ activeMergeSeed ∪ userCollapsed) \ userExpanded
  // A manual expand authoritatively wins over the seed and over a manual
  // collapse, so the fold→expand→collapse round-trip stays reversible (Defect 4).
  // NOTE: `viewMode` is now a prop (lifted to App.tsx) so the "Collapse merged
  // branches" switch can live in the left scope overlay.
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set());

  // Flipping the "Collapse merged branches" switch (viewMode) should visibly
  // re-assert the DEFAULT fold state for every merge — otherwise a merge the
  // user has manually folded/expanded is pinned by its override and the switch
  // appears to do nothing (the user's "manual hide/show is conflicting" report).
  // So on a genuine view-mode change we DROP the user's MERGE-PATH overrides
  // (ids matching `isMergePathId`), letting the toggle's mergeSeed take over for
  // all merges. Region-fold overrides are unrelated to the switch and are kept.
  const prevViewMode = useRef<ViewMode>(viewMode);
  useEffect(() => {
    if (prevViewMode.current === viewMode) return;
    prevViewMode.current = viewMode;
    const dropMergePaths = (prev: Set<string>) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (isMergePathId(id)) {
          changed = true;
          continue;
        }
        next.add(id);
      }
      return changed ? next : prev;
    };
    setUserCollapsed(dropMergePaths);
    setUserExpanded(dropMergePaths);
  }, [viewMode]);

  const nodeByOid = useMemo(() => {
    const m = new Map<string, CommitNode>();
    for (const n of graph.nodes) m.set(n.oid, n);
    return m;
  }, [graph.nodes]);

  const AUTO_COLLAPSE_LEN = 8;

  // The commit HEAD points at — anchors the trunk (lane 0) and the working node,
  // and is the exemption anchor for the auto-collapse seed (2.13).
  const headOid = useMemo(() => {
    const head = graph.refs.find((r) => r.is_head);
    return head?.oid ?? graph.nodes[0]?.oid ?? null;
  }, [graph.refs, graph.nodes]);

  // On load / whenever the graph changes, RE-DERIVE the default seeds from the
  // current node set and reset the user's manual overrides. Both seeds are
  // stable string ids keyed on a stable oid (region anchor oid / merge oid), so
  // a live-update graph shift / re-fetch doesn't desync the fold state — they're
  // re-derived from anchors that persist across the window (6.3).
  //
  //   - regionSeed: long off-trunk linear regions auto-fold (Round 3), HEAD
  //     trunk exempt (2.13). Applied in BOTH view modes.
  //   - mergeSeed:  the merge default view (`leafTipVisibility`) folds every
  //     merge whose secondary path is not a leaf line. Applied ONLY in "active"
  //     mode (the view-mode toggle flips this on/off — 13.3).
  //
  // Manual fold/expand overrides layer on top via composeFoldSeed and are reset
  // here (a genuine graph change) but NOT on a mere view-mode toggle.
  const [regionSeed, setRegionSeed] = useState<Set<string>>(new Set());
  const [mergeSeed, setMergeSeed] = useState<Set<string>>(new Set());

  // A stable signature of the current window's commit set. Live updates re-fetch
  // the graph and hand us a NEW object even when nothing relevant changed (e.g. a
  // staging-only .git write); comparing OIDs lets us tell a genuine window change
  // from a no-op refetch so we don't blow away the user's manual fold/expand.
  const nodeSig = useMemo(
    () => graph.nodes.map((n) => n.oid).join(","),
    [graph.nodes],
  );
  const prevNodeSig = useRef<string | null>(null);

  // A stable signature of EVERYTHING the default seeds are derived from — the
  // commit set (`nodeSig`), the edge set, and the ref set (branch/tag/HEAD oids
  // + which is HEAD). The seeds (`autoCollapseAnchors`, `leafTipVisibility`) are
  // pure functions of exactly these, so when the signature is unchanged a
  // live-update refetch that hands us fresh-but-identical objects would
  // recompute the SAME seeds — gating on this signature skips that wasted work
  // (the collapse passes are the graph's hot path). A genuine change (window
  // slide, branch move, new commit) changes the signature and re-seeds.
  const seedSig = useMemo(() => {
    const edgeSig = graph.edges.map((e) => `${e.source}>${e.target}`).join(",");
    const refSig = graph.refs
      .map((r) => `${r.oid}:${r.kind}:${r.is_head ? 1 : 0}`)
      .join(",");
    return `${nodeSig}|${edgeSig}|${refSig}`;
  }, [nodeSig, graph.edges, graph.refs]);
  const prevSeedSig = useRef<string | null>(null);

  useEffect(() => {
    // Gate: skip the recompute entirely when nothing the seeds depend on has
    // changed. Without this, every no-op live-update refetch re-runs the O(N+E)
    // collapse seed passes over the full node set for an identical result.
    if (prevSeedSig.current === seedSig) return;
    prevSeedSig.current = seedSig;

    const region = autoCollapseAnchors(
      graph.nodes,
      graph.edges,
      headOid,
      refsByOid,
      AUTO_COLLAPSE_LEN,
    );
    const merge = leafTipVisibility(graph.nodes, graph.edges, graph.refs);
    setRegionSeed(new Set(region));
    setMergeSeed(merge);
    // Only discard the user's manual overrides when the actual commit set
    // changed (opened a different repo, moved the time window, changed branch
    // visibility). A live-update refetch that yields the same commits preserves
    // whatever the user manually folded/expanded. This is a SEPARATE, stricter
    // condition than the seed gate above: a branch move re-seeds (seedSig
    // changed) but keeps the user's folds (nodeSig unchanged).
    if (prevNodeSig.current !== nodeSig) {
      setUserCollapsed(new Set());
      setUserExpanded(new Set());
      prevNodeSig.current = nodeSig;
    }
  }, [graph.nodes, graph.edges, graph.refs, headOid, refsByOid, nodeSig, seedSig]);

  // Effective folded ids: compose the default seeds (region always, merge only
  // in "active" mode) with the user's manual overrides. A view-mode flip only
  // changes whether `mergeSeed` participates — `userCollapsed`/`userExpanded`
  // are unchanged, so per-merge manual state survives the toggle (13.3).
  const effectiveFolded = useMemo(
    () => composeFoldSeed(viewMode, regionSeed, mergeSeed, userCollapsed, userExpanded),
    [viewMode, regionSeed, mergeSeed, userCollapsed, userExpanded],
  );

  // Build the composed fold: merge secondary-path folds AND Round-3 region
  // folds resolved in ONE pass, with merge folds taking precedence. The
  // effectively-folded set carries BOTH kinds of stable ids; split it into
  // merge-path ids and region anchors for the resolver. `resolveMergeAndRegionFold`:
  //   - rebuilds each folded merge path's hide set (renderAnchor = merge oid,
  //     Option A — no minted node) and computes the merge-hidden member set Hm,
  //   - seeds regions ONLY over commits not in Hm (a merge-hidden commit is not
  //     a region candidate — 7.1/7.2/7.4), keeping the two memberships disjoint,
  //   - folds both kinds via `applyCollapse` (reused UNCHANGED) into one graph.
  // Expanding a merge path drops its members from Hm, so those commits regain
  // region candidacy on the next recompute (7.3) — no special handling needed.
  const foldedMergePathIds = useMemo(() => {
    const s = new Set<string>();
    for (const id of effectiveFolded) if (isMergePathId(id)) s.add(id);
    return s;
  }, [effectiveFolded]);

  const regionAnchors = useMemo(() => {
    const s = new Set<string>();
    for (const id of effectiveFolded) if (!isMergePathId(id)) s.add(id);
    return s;
  }, [effectiveFolded]);

  const resolved = useMemo(
    () =>
      resolveMergeAndRegionFold(
        graph.nodes,
        graph.edges,
        refsByOid,
        selectedOid,
        foldedMergePathIds,
        regionAnchors,
      ),
    [graph.nodes, graph.edges, refsByOid, selectedOid, foldedMergePathIds, regionAnchors]
  );

  const collapsed = resolved.eff;

  // ── Click-to-highlight merged commits ─────────────────────────────────────
  // When the selected node is a MERGE, highlight the commits it merged in: the
  // union of every secondary parent's introduced set (`reachable(Pk) \
  // reachable(P1)`), computed with the SAME `mergeSecondaryPath` used for the
  // fold hide sets — so it works for sync merges (not foldable) and integration
  // merges alike. Highlighted commits get a ring in the node components. Only
  // the members that are currently rendered light up; folded-away ones stay
  // hidden (their fold summary still highlights via its own membership).
  const highlightedOids = useMemo(() => {
    const set = new Set<string>();
    if (!selectedOid) return set;
    const sel = nodeByOid.get(selectedOid);
    if (!sel || sel.parents.length < 2) return set;
    for (let k = 1; k < sel.parents.length; k++) {
      const path = mergeSecondaryPath(selectedOid, k, graph.nodes, graph.edges);
      if (path) for (const o of path.oids) set.add(o);
    }
    return set;
  }, [selectedOid, nodeByOid, graph.nodes, graph.edges]);

  // Per-merge SYNC-side metadata for the merge node badge: the introduced-commit
  // count for each secondary parent classified `sync` (server `merge_sides`).
  // Sync sides carry no fold affordance, so the node can't read the count off
  // `hiddenGroups`; we compute it here from `mergeSecondaryPath` (the same
  // reachable-difference used everywhere else), keyed by merge oid.
  const syncSidesByMerge = useMemo(() => {
    const m = new Map<string, { parentIndex: number; count: number; fromName: string | null }[]>();
    for (const n of graph.nodes) {
      const sides = (n.merge_sides ?? []).filter((s) => s.kind === "sync");
      if (sides.length === 0) continue;
      const entries = sides.map((s) => {
        const path = mergeSecondaryPath(n.oid, s.parent_index, graph.nodes, graph.edges);
        return {
          parentIndex: s.parent_index,
          count: path?.oids.length ?? 0,
          fromName: mergedBranchName(n.summary),
        };
      });
      m.set(n.oid, entries);
    }
    return m;
  }, [graph.nodes, graph.edges]);

  // Effective edge list + region summary nodes after collapsing — everything
  // downstream (lanes, positions, flow nodes/edges) operates on these.
  const effEdges = collapsed.edges;
  const runNodes = collapsed.runNodes;

  // Fold the contiguous region OR merge secondary path anchored at `anchorId`
  // (manual collapse). `anchorId` is a stable id: a region anchor oid OR a
  // `mergePathId(M,k)` (both stable-oid-derived). Recorded as a USER override
  // (userCollapsed) separate from the default seed, so it survives a view-mode
  // toggle (13.3). Single fold entry point for both kinds — the resolver keys
  // off `isMergePathId` to route it.
  //
  // Selection-follow (Req 22 / Property 12): when the group being folded
  // includes the currently selected commit, move selection onto the resulting
  // summary node by re-selecting the fold's representative — its newest member
  // `oids[0]`, matching `selectionForSummaryNode` and the existing expand path.
  // Folds that do NOT contain the selected commit leave selection unchanged.
  const collapseRegion = useCallback(
    (anchorId: string) => {
      setUserCollapsed((prev) => new Set(prev).add(anchorId));
      setUserExpanded((prev) => {
        if (!prev.has(anchorId)) return prev;
        const next = new Set(prev);
        next.delete(anchorId);
        return next;
      });

      // Determine the folded group's members for `anchorId`, keyed on its id
      // kind: a merge secondary path (`mergePathId`) vs a region anchor.
      if (selectedOid === null) return;
      let members: string[] | null | undefined;
      const parsed = isMergePathId(anchorId) ? parseMergePathId(anchorId) : null;
      if (parsed) {
        members = mergeSecondaryPath(
          parsed.mergeOid,
          parsed.parentIndex,
          graph.nodes,
          graph.edges,
        )?.oids;
      } else {
        members = regionAround(
          anchorFromId(anchorId),
          graph.nodes,
          graph.edges,
          refsByOid,
        );
      }
      if (!members || members.length === 0) return;
      // Re-select the representative (newest member) only when the fold hides
      // the selected commit; `members[0]` = `selectionForSummaryNode` semantics.
      if (members.includes(selectedOid)) onSelectCommit(members[0]);
    },
    [selectedOid, onSelectCommit, graph.nodes, graph.edges, refsByOid],
  );

  // Expand the region OR merge secondary path anchored at `anchorId` (records a
  // USER expand override, clears any user collapse). A manual expand
  // authoritatively wins over the default seed and a prior manual collapse via
  // `composeFoldSeed`, so the whole group un-folds in one action and stays
  // un-folded across re-renders and view-mode toggles (Defect 6 / 13.3).
  const expandRegion = useCallback((anchorId: string) => {
    setUserExpanded((prev) => new Set(prev).add(anchorId));
    setUserCollapsed((prev) => {
      if (!prev.has(anchorId)) return prev;
      const next = new Set(prev);
      next.delete(anchorId);
      return next;
    });
  }, []);

  // Toggle a single merge secondary path (mergeOid, parentIndex). Threaded onto
  // merge node data so task 7's MergeNodeComponent can flip a path folded ⇄
  // expanded via one call, keyed on the stable merge oid (6.2). The `folded`
  // flag comes from the affordance metadata computed by the resolver.
  const onTogglePath = useCallback(
    (mergeOid: string, parentIndex: number, folded: boolean) => {
      const id = mergePathId(mergeOid, parentIndex);
      if (folded) expandRegion(id);
      else collapseRegion(id);
    },
    [collapseRegion, expandRegion]
  );

  // Which commits are eligible for an on-demand region-collapse control: any
  // commit whose contiguous region has >= 2 members (Defect 1.10, 2.8) AND that
  // is NOT currently hidden behind a merge secondary path. Merge folds take
  // precedence, so a merge-hidden commit is offered no region control (7.2);
  // once its merge path is expanded it drops out of `mergeHidden` and regains
  // candidacy here (7.3). Memoized over the loaded graph + merge-hidden set.
  // Fold-control eligibility (Task 18.3). `foldableNodeIds` is a single pure,
  // selection-invariant sweep that marks EVERY member of every >= 2-member
  // foldable region eligible (not just the head) and maps each to the canonical
  // anchor `collapseRegion` should fold from. Merge folds still take precedence
  // (7.2): subtract the merge-hidden members so a commit hidden behind a merge
  // secondary path is offered no region control; it regains candidacy once its
  // merge path is expanded and it drops out of `mergeHidden` (7.3).
  const { eligible, anchorFor } = useMemo(
    () => foldableNodeIds(graph.nodes, graph.edges, refsByOid),
    [graph.nodes, graph.edges, refsByOid],
  );
  const regionEligible = useMemo(() => {
    const set = new Set<string>();
    for (const id of eligible) {
      if (resolved.mergeHidden.has(id)) continue; // merge precedence (7.2)
      set.add(id);
    }
    return set;
  }, [eligible, resolved.mergeHidden]);

  // Fold the node's CONTAINING region when its control is activated: any member
  // resolves to the same canonical anchor via `anchorFor`, so a click on an
  // interior member folds the whole region (not just when the head is clicked).
  const onCollapseNode = useCallback(
    (oid: string) => collapseRegion(anchorFor.get(oid) ?? oid),
    [collapseRegion, anchorFor],
  );

  // Combined render order: walk the ORIGINAL graph order; when we hit a commit
  // that folded into a run, emit the run node once (at the position of its
  // newest member) and skip the rest. This gives run nodes a row index inline
  // with the surrounding commits.
  const renderOrder = useMemo(() => {
    const order: string[] = [];
    const emittedRun = new Set<string>();
    for (const n of graph.nodes) {
      const runId = collapsed.foldedInto.get(n.oid);
      if (runId) {
        // This commit is folded away. Emit its fold's render id at this position
        // ONLY when that id is a MINTED summary/run node (region rollup) — those
        // exist nowhere else, so their row is defined by where their members sat.
        //
        // Option-A merge folds instead reuse an EXISTING commit (the merge) as
        // the anchor: `runId` is the merge's own oid, which is NOT a minted run
        // node and is emitted on its own turn at its real (top) position. Do NOT
        // re-emit it here — doing so pushes the merge oid a SECOND time down at
        // the folded members' old position, and since `indexByOid` keeps the
        // last index, the merge's row gets hijacked to just above the branch
        // point instead of staying at the mainline tip. So for merge folds we
        // simply drop the folded members and let the anchor keep its own row.
        if (collapsed.runNodes.has(runId) && !emittedRun.has(runId)) {
          order.push(runId);
          emittedRun.add(runId);
        }
      } else {
        order.push(n.oid);
      }
    }
    return order;
  }, [graph.nodes, collapsed.foldedInto, collapsed.runNodes]);

  // First-parent map among RENDERED ids (commit oids + summary node ids). Used
  // by the lane algorithm so a merge's 2nd+ parents branch into their own lane
  // instead of inheriting the merge's lane. A commit's first parent is
  // graph parents[0], mapped through any collapse fold to its render id.
  //
  // Crucial exception for lane stability: when a commit's real first parent was
  // folded into a FOREIGN existing commit (an Option-A merge fold, where the
  // render anchor is another commit's oid — e.g. main's `06d07b2` folded into
  // the feature-side merge `fbea557`), that is NOT a first-parent continuation
  // for layout. Treating it as one would route the trunk run THROUGH that merge
  // and drag the merge into the trunk lane when the branch collapses (the
  // lane-hopping). We only follow the fold when the first parent maps to ITSELF
  // (rendered normally) or to a MINTED run/summary node that represents this
  // commit's own folded first-parent line. Otherwise the run simply ends here.
  const firstParentOf = useMemo(() => {
    const renderId = (oid: string) => collapsed.foldedInto.get(oid) ?? oid;
    const m = new Map<string, string>();
    for (const n of graph.nodes) {
      const self = renderId(n.oid);
      const fp = n.parents[0];
      if (!fp) continue;
      const fpRender = renderId(fp);
      if (fpRender === self) continue;
      // Skip first-parent continuation into a foreign Option-A merge anchor: the
      // first parent folded into an EXISTING different commit, not a minted run
      // node. `collapsed.runNodes` holds only minted summary/run ids, so a
      // fpRender that is NOT a run node but differs from the real first parent
      // means the parent was absorbed by a foreign commit anchor — not our run.
      const foldedIntoForeignCommit =
        fpRender !== fp && !collapsed.runNodes.has(fpRender);
      if (foldedIntoForeignCommit) continue;
      if (!m.has(self)) m.set(self, fpRender);
    }
    return m;
  }, [graph.nodes, collapsed.foldedInto, collapsed.runNodes]);

  // The single trunk-tip RENDER ID pinned to lane 0. The trunk is a user-chosen
  // branch (the `trunkBranch` prop, default main/master); we resolve its NAME to
  // its tip oid from the ref labels, then map that oid through the current fold
  // to its render id (an original commit that folded into a run node carries the
  // lane-0 anchor onto that run node). Falls back to HEAD, then the newest node,
  // so there is always a sensible lane-0 spine. This is the ONLY trunk input to
  // layout — `assignLanes` reserves lane 0 for this run and lets it propagate
  // down its first-parent chain; there is no trunk membership set and no merge
  // special-casing (a merge just lands in its P1's lane).
  const trunkTipRender = useMemo(() => {
    const nameMatch = (want: string) =>
      graph.refs.find(
        (r) => (r.kind === "branch" || r.kind === "remotebranch") && r.name === want,
      )?.oid;
    // 1) explicit chosen branch, 2) main, 3) master, 4) HEAD, 5) newest node.
    const tipOid =
      (trunkBranch ? nameMatch(trunkBranch) : undefined) ??
      nameMatch("main") ??
      nameMatch("master") ??
      headOid ??
      graph.nodes[0]?.oid ??
      null;
    if (!tipOid) return null;
    // Map through the fold so a folded trunk tip still anchors lane 0 on its
    // render node.
    return collapsed.foldedInto.get(tipOid) ?? tipOid;
  }, [graph.refs, graph.nodes, trunkBranch, headOid, collapsed.foldedInto]);

  const lanes = useMemo(
    () => assignLanes(renderOrder, effEdges, trunkTipRender, firstParentOf),
    [renderOrder, effEdges, trunkTipRender, firstParentOf]
  );

  // Row (vertical level) of each rendered id — derived from the DAG topology so
  // a parent hugs its lowest child (one row below), NOT from the flat order.
  // This prevents lane 0 (trunk) from leaving tall empty gaps opposite stacks of
  // unrelated side-lane nodes: rows now count DEPTH, and same-depth nodes in
  // different lanes share a row. See `assignRows`.
  const indexByOid = useMemo(
    () => assignRows(renderOrder, effEdges),
    [renderOrder, effEdges],
  );

  // Number of distinct rows (max row index + 1).
  const rowCount = useMemo(() => {
    let max = -1;
    for (const r of indexByOid.values()) if (r > max) max = r;
    return max + 1;
  }, [indexByOid]);

  // ── Stash badges ──────────────────────────────────────────────────────────
  // A stash is not a ref pointing at a commit; it's a set of changes layered on
  // top of the commit it was created on (its first parent = `base_oid`). So we
  // DON'T float a node in its own lane — that reads as clutter "just hanging
  // around". Instead each base commit gets a compact stash badge; CLICKING it
  // SELECTS the stash (its synthetic `__stash__<index>` id), which drives the
  // existing StashPanel diff in the right pane and shades the base commit as the
  // active context. No node is ever minted for a based stash. Stashes whose base
  // is off-window have no badge host, so they still render as a node (orphans)
  // so they're never lost.

  // Stashes grouped by the in-window base commit they were created on. Drives
  // the compact per-commit stash badge.
  const stashesByBase = useMemo(() => {
    const m = new Map<string, import("../../api/client").StashEntry[]>();
    if (!status) return m;
    for (const stash of status.stashes) {
      if (stash.base_oid && indexByOid.has(stash.base_oid)) {
        if (!m.has(stash.base_oid)) m.set(stash.base_oid, []);
        m.get(stash.base_oid)!.push(stash);
      }
    }
    return m;
  }, [status, indexByOid]);

  // A stash is only ever shown as a badge on its base commit, and only when that
  // base is in the rendered window. If the base isn't rendered — either off the
  // loaded window or folded away inside a collapsed run / merge secondary path —
  // the stash simply isn't drawn in the graph. It's never lost: it stays
  // reachable via the stash list / right-pane StashPanel. We deliberately do NOT
  // float an "orphan" node for it, because a stash carries no meaningful graph
  // position of its own, so a floating node reads as clutter that appears and
  // disappears as folds change (e.g. merging main into a feature branch folds
  // the mainline and would otherwise orphan every stash anchored there).
  const visibleStashIndices = useMemo(() => new Set<number>(), []);

  // The stash index currently selected (its `__stash__<index>` node is the
  // selection), or null. Used to shade its base commit's badge as active.
  const selectedStashIndex = useMemo(
    () => (selectedOid && isStashId(selectedOid) ? stashIndexFromId(selectedOid) : null),
    [selectedOid],
  );

  // ── Height-aware row Y positions ────────────────────────────────────────
  // Each row's Y is the running sum of the PREVIOUS rows' heights plus a
  // constant gap, so a tall card (many ref badges / merge affordances / a stash
  // badge / folded refs) can never overlap the row below it, while the gap
  // between rows stays constant (uniform spacing). A row can hold several nodes
  // (one per lane), so a row's height is the MAX estimated card height across
  // every node assigned to that row (`indexByOid`). Height is estimated per node
  // from its data (DOM-free, deterministic) via `estimateNodeHeight`.
  const rowTops = useMemo(() => {
    const heightOf = (id: string): number => {
      const runData = runNodes.get(id);
      if (runData) {
        return estimateNodeHeight({
          kind: "run",
          foldedRefLabels: (runData.foldedRefs ?? []).map((fr) => fr.ref.name),
        });
      }
      const commit = nodeByOid.get(id);
      if (!commit) return estimateNodeHeight({ kind: "commit" });
      const isMerge = commit.parents.length >= 2;
      const refLabels = (refsByOid.get(id) ?? []).map((r) => r.name);
      if (isMerge) {
        const affordances = resolved.affordancesByMerge.get(id) ?? [];
        return estimateNodeHeight({
          kind: "merge",
          refLabels,
          affordanceCount: affordances.length,
          foldedRefLabels: affordances
            .filter((a) => a.folded)
            .flatMap((a) => a.foldedRefs.map((fr) => fr.ref.name)),
        });
      }
      return estimateNodeHeight({
        kind: "commit",
        refLabels,
        hasStash: (stashesByBase.get(id)?.length ?? 0) > 0,
      });
    };
    // Max card height per row across all lanes occupying that row.
    const rowHeights = new Array<number>(rowCount).fill(0);
    for (const id of renderOrder) {
      const row = indexByOid.get(id);
      if (row === undefined) continue;
      const h = heightOf(id);
      if (h > rowHeights[row]) rowHeights[row] = h;
    }
    // A row with no measurable node still needs a sane default height.
    const base = estimateNodeHeight({ kind: "commit" });
    for (let i = 0; i < rowHeights.length; i++) {
      if (rowHeights[i] === 0) rowHeights[i] = base;
    }
    return computeRowTops(rowHeights, Y_BASE);
  }, [renderOrder, indexByOid, rowCount, runNodes, nodeByOid, refsByOid, resolved.affordancesByMerge, stashesByBase]);

  // Resolve the absolute top Y of a row index. Rows at or below 0 use the
  // computed height-aware tops; a row ABOVE the topmost node (index -1, where
  // the working node sits when HEAD is the newest commit) is derived by
  // stepping one working-node height + gap above row 0 so it never overlaps it.
  const yForRow = useCallback(
    (row: number) => {
      if (row >= 0) return rowTops[row] ?? Y_BASE + row * ROW_HEIGHT;
      const specialH = estimateNodeHeight({ kind: "special" });
      return (rowTops[0] ?? Y_BASE) - (specialH + ROW_GAP) * -row;
    },
    [rowTops],
  );

  const flowNodes: Node[] = useMemo(
    () =>
      renderOrder.map((id) => {
        const y = yForRow(indexByOid.get(id) ?? 0);
        const runData = runNodes.get(id);
        if (runData) {
          // Collapsed run summary node.
          return {
            id,
            type: "run",
            position: { x: X_BASE + (lanes.get(id) ?? 0) * LANE_WIDTH, y },
            data: {
              ...runData,
              selected: id === selectedOid,
              onExpand: (rid: string) => expandRegion(anchorFromId(rid)),
            },
            selected: id === selectedOid,
          } as Node;
        }
        // Regular commit node, OR a first-class merge node when the commit has
        // >= 2 parents. Merge commits carry per-secondary-parent affordance
        // metadata + a toggle so `MergeNodeComponent` can render the
        // hidden-branch affordances; the data object is identical for both types
        // (non-merges just have an empty `hiddenGroups`).
        const commit = nodeByOid.get(id)!;
        const hiddenGroups: MergeAffordance[] =
          resolved.affordancesByMerge.get(id) ?? [];
        const isMerge = commit.parents.length >= 2;
        return {
          id,
          type: isMerge ? "merge" : "commit",
          position: { x: X_BASE + (lanes.get(id) ?? 0) * LANE_WIDTH, y },
          data: {
            commit,
            refs: refsByOid.get(id) ?? [],
            selected: id === selectedOid,
            onSelect: onSelectCommit,
            canCollapse: regionEligible.has(id),
            onCollapse: onCollapseNode,
            // Merge affordance data (empty for non-merges / merges with no
            // non-empty hide set → no affordance rendered).
            hiddenGroups,
            onTogglePath,
            // Sync-side badge metadata (introduced count + branch name) for
            // merges that pulled in a still-living line. Empty for non-syncs.
            syncSides: syncSidesByMerge.get(id) ?? [],
            // Highlight ring: this commit is one of the commits merged in by the
            // currently-selected merge (click-to-highlight).
            highlighted: highlightedOids.has(id),
            // Compact stash badge: the stashes based on THIS commit, and
            // whether one of them is the current selection (so the badge shades
            // as active). Clicking selects a stash → drives the StashPanel diff.
            // Empty array → no badge rendered.
            stashes: stashesByBase.get(id) ?? [],
            selectedStashIndex,
            onSelectStash: (index: number) => onSelectCommit(stashNodeId(index)),
          },
          selected: id === selectedOid,
        } as Node;
      }),
    [renderOrder, lanes, indexByOid, yForRow, refsByOid, selectedOid, onSelectCommit, runNodes, nodeByOid, regionEligible, onCollapseNode, expandRegion, resolved.affordancesByMerge, onTogglePath, stashesByBase, selectedStashIndex, syncSidesByMerge, highlightedOids]
  );

  // Working-tree pseudo-node placement (shared by the node and its edge). It
  // normally sits one row ABOVE HEAD in HEAD's lane. But when HEAD is NOT a leaf,
  // that row/lane is occupied by HEAD's child commit(s), so we place the working
  // node in a FREE lane on that row: compute the lanes occupied at the target row
  // (HEAD's row index − 1) across all rendered nodes, then pick the lowest free
  // lane at or to the RIGHT of HEAD's lane. If HEAD is a leaf its own lane is
  // free and the node sits straight above, as before. `offset` is true when the
  // node ended up right of HEAD (used to route the edge through HEAD's side).
  // `yForRow` keeps its Y aligned to the height-aware row tops.
  const workingPlacement = useMemo(
    () => computeWorkingPlacement(headOid, indexByOid, lanes, yForRow),
    [headOid, indexByOid, lanes, yForRow],
  );

  // Stash pseudo-node placements. Each stash "grows out of" its base commit
  // (the commit it was created on), so — like the working node above HEAD — it
  // anchors one row ABOVE its base in a collision-free lane. We share ONE
  // reserved-cell set seeded with every rendered node AND the working node's
  // cell, then place stashes in order, so a stash never overlaps a commit, the
  // working node, or another stash (e.g. several stashes all based on HEAD fan
  // out to the right). Stashes whose base is outside the loaded window fall back
  // to a dedicated far-right column near the top so they stay visible.
  const stashPlacements = useMemo(() => {
    const map = new Map<number, WorkingPlacement | null>();
    if (!status) return map;
    const reserved = reservedCellsFrom(indexByOid, lanes);
    // Reserve the working node's cell so stashes never land on it.
    if (workingPlacement) {
      reserved.add(`${workingPlacement.lane},${workingPlacement.row}`);
    }
    // Only VISIBLE stashes (expanded or orphaned) claim a cell — collapsed
    // stashes live as a badge on their base commit and take no lane.
    status.stashes.forEach((stash) => {
      if (!visibleStashIndices.has(stash.index)) return;
      const base = stash.base_oid && indexByOid.has(stash.base_oid)
        ? stash.base_oid
        : null;
      map.set(stash.index, placeAboveBase(base, indexByOid, lanes, reserved, yForRow));
    });
    return map;
  }, [status, workingPlacement, indexByOid, lanes, visibleStashIndices, yForRow]);

  // Working-tree pseudo-node (working + staged) + one node per stash.
  const specialNodes: Node[] = useMemo(() => {
    if (!status) return [];
    const out: Node[] = [];

    if (workingPlacement) {
      out.push({
        id: WORKING_NODE_ID,
        type: "special",
        position: { x: workingPlacement.x, y: workingPlacement.y },
        data: {
          id: WORKING_NODE_ID,
          kind: "working",
          title: "Working tree",
          subtitle: status.is_dirty ? undefined : "clean — no changes",
          badges: status.is_dirty
            ? [
                { label: "staged", value: status.staged_count },
                { label: "unstaged", value: status.unstaged_count },
              ]
            : undefined,
          selected: selectedOid === WORKING_NODE_ID,
          onSelect: onSelectCommit,
        },
        selected: selectedOid === WORKING_NODE_ID,
      });
    }

    // Stash nodes: only ORPHAN stashes (their base is off-window, so there's no
    // badge host commit to attach to). Based stashes never mint a node — they
    // live as a badge on their base commit. With no in-window base an orphan
    // falls back to a far-right column near the top.
    status.stashes.forEach((stash) => {
      if (!visibleStashIndices.has(stash.index)) return;
      const placement = stashPlacements.get(stash.index);
      const id = stashNodeId(stash.index);
      const pos = placement
        ? { x: placement.x, y: placement.y }
        : { x: X_BASE, y: Y_BASE + stash.index * ROW_HEIGHT };
      out.push({
        id,
        type: "special",
        position: pos,
        data: {
          id,
          kind: "stash",
          title: `stash@{${stash.index}}`,
          subtitle: stash.message,
          selected: selectedOid === id,
          onSelect: onSelectCommit,
        },
        selected: selectedOid === id,
      });
    });

    return out;
  }, [status, workingPlacement, stashPlacements, visibleStashIndices, selectedOid, onSelectCommit]);

  const flowEdges: Edge[] = useMemo(() => {
    // Occupancy grid of `lane,row` cells that hold a node, so `pickEdgePorts`
    // can route an edge through a VERTICAL port only when the column between the
    // two endpoints is actually empty — otherwise it enters/leaves through the
    // facing SIDE and the line never runs behind a stacked card.
    const occupied = new Set<string>();
    for (const [id, row] of indexByOid) {
      occupied.add(`${lanes.get(id) ?? 0},${row}`);
    }
    const isOccupied = (lane: number, row: number) => occupied.has(`${lane},${row}`);

    return effEdges
      // Defensive: React Flow throws (blanking the whole canvas) if an edge
      // references a node that isn't present. Drop any such dangling edges.
      .filter((e) => indexByOid.has(e.source) && indexByOid.has(e.target))
      .map((e) => {
        // source = parent (lower on screen), target = child (higher on screen).
        // `lanes` now covers commits AND summary nodes, so a plain lookup works.
        // Port selection is delegated to `pickEdgePorts`, which chooses the
        // source/target handles from the two nodes' relative grid positions AND
        // the occupancy grid (see edgePorts.ts) so each end connects through the
        // side that faces the other node without crossing an intervening card.
        const { sourceHandle, targetHandle } = pickEdgePorts(
          { lane: lanes.get(e.source) ?? 0, row: indexByOid.get(e.source) ?? 0 },
          { lane: lanes.get(e.target) ?? 0, row: indexByOid.get(e.target) ?? 0 },
          isOccupied,
        );

        return {
          id: `${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          sourceHandle,
          targetHandle,
          // Bezier curve routing (React Flow "default"). The port selection
          // above keeps each end docking on the side facing the other node so
          // the curve stays in the gutter between lanes rather than under a card.
          type: "default",
          style: { stroke: "#30363d", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#30363d" },
        } as Edge;
      });
  }, [effEdges, lanes, indexByOid]);

  // Dashed edges connecting pseudo-nodes to the commits they build on.
  const specialEdges: Edge[] = useMemo(() => {
    if (!status) return [];
    const out: Edge[] = [];

    // Working → HEAD dashed edge. Rendered whenever HEAD is in the loaded
    // window, matching the always-on working node above (independent of dirty).
    if (headOid && indexByOid.has(headOid)) {
      // Arrow points HEAD → working: HEAD (below on screen) emits toward the
      // working node's bottom. Direction reads as "the tip commit leads into
      // the uncommitted working state". When the working node is offset to the
      // RIGHT (HEAD is not a leaf), emit from HEAD's right side so the line
      // bends cleanly instead of cutting across HEAD's children; otherwise emit
      // straight up from HEAD's top.
      const offset = workingPlacement?.offset ?? false;
      out.push({
        id: `${headOid}-${WORKING_NODE_ID}`,
        source: headOid,
        target: WORKING_NODE_ID,
        sourceHandle: offset ? "s-right" : "s-top",
        targetHandle: "t-bottom",
        type: "default",
        style: { stroke: "#2f855a", strokeWidth: 2, strokeDasharray: "4 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#2f855a" },
      });
    }

    status.stashes.forEach((stash) => {
      // Only draw the edge when this stash is actually shown as a node.
      if (!visibleStashIndices.has(stash.index)) return;
      if (stash.base_oid && indexByOid.has(stash.base_oid)) {
        const id = stashNodeId(stash.index);
        // Arrow points base → stash, matching the HEAD → working direction: the
        // base commit (below on screen) leads into the stashed state above it.
        // The stash sits one row ABOVE its base; when it's offset to the RIGHT
        // (base is not a leaf, or it dodged the working node / another stash),
        // emit from the base's right side so the line bends cleanly instead of
        // cutting across the base's children; otherwise emit straight up.
        const offset = stashPlacements.get(stash.index)?.offset ?? false;
        out.push({
          id: `${stash.base_oid}-${id}`,
          source: stash.base_oid,
          target: id,
          sourceHandle: offset ? "s-right" : "s-top",
          targetHandle: "t-bottom",
          type: "default",
          style: { stroke: "#b7791f", strokeWidth: 2, strokeDasharray: "4 3" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#b7791f" },
        });
      }
    });

    return out;
  }, [status, headOid, indexByOid, workingPlacement, stashPlacements, visibleStashIndices]);

  const allNodes = useMemo(
    () => [...flowNodes, ...specialNodes],
    [flowNodes, specialNodes]
  );
  const allEdges = useMemo(
    () => [...flowEdges, ...specialEdges],
    [flowEdges, specialEdges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(allEdges);

  useEffect(() => {
    setNodes(allNodes);
    setEdges(allEdges);
  }, [allNodes, allEdges, setNodes, setEdges]);

  // Initial viewport, computed once: "home" = HEAD (or the top of the graph)
  // near the top-left with a little padding. This makes the default state land
  // on HEAD without any imperative jump after render.
  const initialViewport = useMemo(() => {
    const homeId = (headOid && indexByOid.has(headOid)) ? headOid : renderOrder[0];
    const zoom = 0.9;
    if (!homeId) return { x: 40, y: 40, zoom };
    const nodeX = X_BASE + (lanes.get(homeId) ?? 0) * LANE_WIDTH;
    const nodeY = Y_BASE + (indexByOid.get(homeId) ?? 0) * ROW_HEIGHT;
    // Place the home node ~40px from the top-left of the pane.
    return { x: 40 - nodeX * zoom, y: 40 - nodeY * zoom, zoom };
    // Compute once on mount; later navigation uses setCenter/fitView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React Flow instance (captured on init) for imperative centering on jump.
  const rfRef = React.useRef<ReactFlowInstance | null>(null);

  // Find/jump: when jumpToOid changes, center + select the target commit. The
  // target may be folded into a rollup/run — center on its render node.
  useEffect(() => {
    if (!jumpToOid) return;
    const renderId = collapsed.foldedInto.get(jumpToOid) ?? jumpToOid;
    const idx = indexByOid.get(renderId);
    if (idx !== undefined) {
      const x = X_BASE + (lanes.get(renderId) ?? 0) * LANE_WIDTH + 90; // ~card center
      const y = Y_BASE + idx * ROW_HEIGHT + 40;
      rfRef.current?.setCenter(x, y, { zoom: 1, duration: 400 });
      if (!isCollapsedRunId(renderId)) onSelectCommit(renderId);
    }
    onJumpConsumed?.();
    // Fire only when the jump TARGET changes, not on every render where layout
    // (lanes/indexByOid), fold state, or the callbacks happen to change identity
    // — those would otherwise re-trigger the same jump/center unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToOid]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Clicking a collapsed region summary node expands the whole region AND
      // selects a representative commit (its newest member) so the right pane
      // updates coherently. Otherwise select the clicked commit.
      if (isCollapsedRunId(node.id)) {
        expandRegion(anchorFromId(node.id));
        const rep = selectionForSummaryNode(node.id, runNodes);
        if (rep) onSelectCommit(rep);
      } else {
        onSelectCommit(node.id);
      }
    },
    [onSelectCommit, expandRegion, runNodes]
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={(inst) => (rfRef.current = inst)}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        defaultViewport={initialViewport}
        fitViewOptions={{ padding: 0.15, minZoom: 0.02, maxZoom: 1.2 }}
        minZoom={0.02}
        maxZoom={1.5}
        attributionPosition="bottom-right"
        colorMode="dark"
        // Only mount nodes/edges within the viewport. With a full window of up to
        // ~500 commit cards (+ edges + MiniMap), this keeps the DOM/paint cost
        // proportional to what's on screen rather than the whole window — the
        // main client-side win for responsiveness on large graphs.
        onlyRenderVisibleElements
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          color="#21262d"
        />
        <Controls />
        <MiniMap
          pannable
          zoomable
          bgColor="#0d1117"
          nodeColor={(node) => {
            if (node.id === WORKING_NODE_ID) return "#34d399";
            if (isStashId(node.id)) return "#fbbf24";
            if (isCollapsedRunId(node.id)) return "#a855f7";
            // Brighter default fill so nodes stay legible when a tall graph is
            // scaled way down and each node becomes a couple of pixels.
            return node.selected ? "#79c0ff" : "#8b949e";
          }}
          nodeStrokeColor="#484f58"
          // Node rects are drawn in flow coordinates then scaled to fit the map,
          // so on a large graph they shrink to dots. A wider stroke keeps each
          // node's outline visible instead of fading into the background.
          nodeStrokeWidth={6}
          nodeBorderRadius={4}
          // Darken the area outside the viewport and give the viewport rect a
          // bright outline, so the current view stays findable even when it's a
          // tiny sliver of a tall graph.
          maskColor="rgba(1,4,9,0.6)"
          maskStrokeColor="#3d6fb0"
          maskStrokeWidth={2}
          // No width/height props in v12 — size the widget purely with CSS. A
          // fixed, capped box letterboxes tall graphs inside it (SVG preserves
          // aspect ratio) instead of stretching the widget tall with empty
          // space down the sides.
          style={{ width: 200, height: 160 }}
          className="!bg-[#161b22] !border !border-[#484f58] !rounded"
        />
      </ReactFlow>
    </div>
  );
}
