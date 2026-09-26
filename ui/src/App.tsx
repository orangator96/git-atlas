import { useState, useEffect, useCallback, useRef, useTransition } from "react";
import { GitBranch, Search, FolderOpen, Loader2, AlertCircle, GitCommit, GitMerge } from "lucide-react";
import { api, GRAPH_NODE_LIMIT, type GraphResponse, type TreeResponse, type StatusSummary } from "./api/client";
import { isTauri, pickDirectory, onFolderDrop } from "./lib/tauri";
import { useLiveUpdates } from "./lib/useLiveUpdates";
import CommitGraph, {
  isWorkingId,
  isStashId,
  stashIndexFromId,
} from "./features/graph/CommitGraph";
import TimeScrubber from "./features/graph/TimeScrubber";
import {
  branchesFromRefs,
  defaultVisibility,
  shownBranchNames,
  nextVisibility,
  type BranchVisibility,
} from "./features/graph/branches";
import { groupBranches } from "./features/graph/branchGroups";
import BranchControl from "./features/graph/BranchControl";
import { controlButtonClass } from "./features/graph/controlStyles";
import ToggleSwitch from "./features/graph/ToggleSwitch";
import type { ViewMode } from "./features/graph/collapse";
import FindRefBox from "./features/graph/FindRefBox";
import WindowBanner from "./features/graph/WindowBanner";
import CommitPanel from "./features/commit/CommitPanel";
import DiffViewer from "./features/diff/DiffViewer";
import FileBrowser from "./features/tree/FileBrowser";
import FileViewer from "./features/tree/FileViewer";
import SearchPanel from "./features/search/SearchPanel";
import { WorkingPanel, StashPanel } from "./features/working/WorkingPanel";
import Tooltip from "./components/Tooltip";

type RightPanel = "commit" | "diff" | "tree" | "search";

export default function App() {
  const [repoPath, setRepoPath] = useState<string>("");
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [openingRepo, setOpeningRepo] = useState(false);
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  // When true, show the repo picker even if a repo is already open (used by "Change repo").
  const [showPicker, setShowPicker] = useState(false);
  // Native folder drag-and-drop hover state (Tauri only).
  const [dragOver, setDragOver] = useState(false);
  const tauri = isTauri();

  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusSummary | null>(null);
  // Time scrubber: full repo range + current window (unix seconds). Null window
  // = no time filter (show everything within limit).
  const [timeBounds, setTimeBounds] = useState<{ newest: number; oldest: number } | null>(null);
  const [timeWindow, setTimeWindow] = useState<{ since: number; until: number } | null>(null);
  // Per-branch visibility (Hidden/Collapsed/Expanded). Computed with a smart
  // default when a repo's refs first load; drives server ref-scoping + rollups.
  const [branchVis, setBranchVis] = useState<Map<string, BranchVisibility>>(new Map());
  const [showBranchControl, setShowBranchControl] = useState(false);
  // Merge-fold view mode. "active" folds merged side-branches behind their merge
  // nodes (the default); "full" expands the whole DAG. Lifted here so the
  // "Collapse merged branches" switch can live in the left scope overlay.
  const [viewMode, setViewMode] = useState<ViewMode>("active");
  // The switch reads this, NOT viewMode. Flipping viewMode drives the graph's
  // O(N+E) re-layout; if the switch's checked state were `viewMode === "active"`
  // it couldn't paint until that deferred work committed, so the track color
  // lagged the click. `switchOn` is urgent local state that flips instantly on
  // click; the heavy viewMode change is then dispatched in a transition. It's
  // kept in sync below so any external viewMode change still reflects.
  const [switchOn, setSwitchOn] = useState(true);
  // Flipping viewMode re-composes the fold set and re-runs the graph's O(N+E)
  // layout; running it in a transition keeps the click responsive and lets the
  // switch paint first. `viewModePending` exposes the in-flight state.
  const [viewModePending, startViewModeTransition] = useTransition();
  // Reconcile the instant switch state if viewMode is changed by anything other
  // than the switch itself (keeps them from drifting).
  useEffect(() => {
    setSwitchOn(viewMode === "active");
  }, [viewMode]);
  // Find/jump: the oid the user wants to center/highlight (consumed by CommitGraph).
  const [jumpToOid, setJumpToOid] = useState<string | null>(null);

  // Which branch is pinned to lane 0 (the trunk / mainline spine). null = the
  // default resolution (main → master → HEAD) inside CommitGraph. The user can
  // override it via the trunk picker in the left scope overlay.
  const [trunkBranch, setTrunkBranch] = useState<string | null>(null);

  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<RightPanel>("commit");

  const [treeData, setTreeData] = useState<TreeResponse | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  async function openRepo(path?: string) {
    const target = path ?? repoPath.trim();
    if (!target) return;
    setOpeningRepo(true);
    setRepoError(null);
    try {
      await api.repo.open(target);
      setRepoOpen(true);
      setShowPicker(false);
      setSelectedOid(null);
      setSelectedFilePath(null);
      setTimeWindow(null);
      setTimeBounds(null);
      setBranchVis(new Map());
      setTrunkBranch(null);
      setRepoPath(target);
      // Refresh the recent list so the just-opened repo moves to the front.
      api.repo.recent().then(setRecentRepos).catch(() => {});
      loadGraph();
    } catch (e) {
      setRepoError(e instanceof Error ? e.message : "Failed to open repository");
    } finally {
      setOpeningRepo(false);
    }
  }

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError(null);
    // Fire the time-bounds walk IN PARALLEL with the graph fetch rather than
    // after it. The scrubber's full range doesn't gate the graph render, and on
    // a cold-cache open both are independent full-history libgit2 walks — kicking
    // timeBounds off here lets them overlap instead of running back-to-back.
    // (Actual overlap depends on the server running the two spawn_blocking walks
    // concurrently; the client no longer serializes them regardless. The deeper
    // fix — one shared walk — belongs to the windowed-load work.) Non-fatal:
    // a timebounds failure just leaves the scrubber without a range.
    api.graph
      .timeBounds()
      .then((b) => {
        if (b.newest_ts != null && b.oldest_ts != null && b.newest_ts > b.oldest_ts) {
          setTimeBounds({ newest: b.newest_ts, oldest: b.oldest_ts });
        } else {
          setTimeBounds(null);
        }
      })
      .catch(() => setTimeBounds(null));
    try {
      const g = await api.graph.get({ limit: GRAPH_NODE_LIMIT });
      setGraph(g);
      if (g.nodes.length > 0) {
        setSelectedOid(g.nodes[0].oid);
      }
      // Working/staged/stash status drives the pseudo-nodes. Non-fatal if it fails.
      api.status.get().then(setStatus).catch(() => setStatus(null));
    } catch (e) {
      setGraphError(e instanceof Error ? e.message : "Failed to load graph");
    } finally {
      setGraphLoading(false);
    }
  }, []);

  // Seamless refresh for live updates: re-fetch graph + status WITHOUT showing
  // the loading spinner or resetting the current selection, so the view updates
  // in place when the repo changes on disk.
  const refreshGraph = useCallback(async () => {
    try {
      const g = await api.graph.get({ limit: GRAPH_NODE_LIMIT });
      setGraph(g);
      // Keep the current selection if it still exists; otherwise fall back to
      // the newest commit (only when nothing is selected).
      setSelectedOid((prev) =>
        prev && g.nodes.some((n) => n.oid === prev)
          ? prev
          : prev ?? (g.nodes[0]?.oid ?? null),
      );
      // Keep the last-known status on a transient fetch failure. Clobbering it
      // to null here would drop the working-tree AND all stash pseudo-nodes
      // (CommitGraph's specialNodes bails on !status) until the next refresh —
      // that's the "stash node briefly disappeared" blip. A fresh repo load
      // (loadGraph) re-establishes status from scratch, so nothing goes stale.
      api.status.get().then(setStatus).catch(() => {
        /* keep previous status */
      });
    } catch {
      // Non-fatal: a transient failure shouldn't disrupt the current view.
    }
  }, []);

  // Compute the smart default branch visibility once, when a repo's refs first
  // load and we have no visibility map yet (main/HEAD expanded, ~5 recent
  // branches collapsed, rest hidden).
  useEffect(() => {
    if (!graph || branchVis.size > 0) return;
    const branches = branchesFromRefs(graph.refs);
    if (branches.length === 0) return;
    setBranchVis(defaultVisibility(branches));
  }, [graph, branchVis.size]);

  // Cycle a branch's visibility: expanded → collapsed → hidden → expanded.
  const cycleBranch = useCallback((name: string) => {
    setBranchVis((prev) => {
      const next = new Map(prev);
      next.set(name, nextVisibility(next.get(name) ?? "hidden"));
      return next;
    });
  }, []);

  // Cycle a group of branches together in lockstep: the next state is computed
  // once (from the group's first member) and applied to every member, so a
  // paired local+remote group toggles as one.
  const cycleBranches = useCallback((names: string[]) => {
    if (names.length === 0) return;
    setBranchVis((prev) => {
      const next = new Map(prev);
      const target = nextVisibility(next.get(names[0]) ?? "hidden");
      for (const name of names) next.set(name, target);
      return next;
    });
  }, []);

  // Re-query the graph scoped to shown branches (collapsed + expanded) when the
  // visibility changes. Debounced. Skips until a visibility map exists.
  const branchDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!repoOpen || branchVis.size === 0) return;
    const shown = shownBranchNames(branchVis);
    if (branchDebounce.current) clearTimeout(branchDebounce.current);
    branchDebounce.current = setTimeout(() => {
      api.graph
        .get({ limit: GRAPH_NODE_LIMIT, refs: shown.length > 0 ? shown : undefined })
        .then((g) => {
          setGraph(g);
          setSelectedOid((prev) =>
            prev && g.nodes.some((n) => n.oid === prev) ? prev : g.nodes[0]?.oid ?? null,
          );
        })
        .catch(() => {});
    }, 250);
    return () => {
      if (branchDebounce.current) clearTimeout(branchDebounce.current);
    };
  }, [branchVis, repoOpen]);

  // Load recent repos and auto-open last repo on startup
  useEffect(() => {
    api.repo.recent().then((recent) => {
      setRecentRepos(recent);
      api.repo.get().then((info) => {
        setRepoPath(info.path);
        setRepoOpen(true);
        loadGraph();
      }).catch(() => {
        if (recent.length > 0) setRepoPath(recent[0]);
      });
    }).catch(() => {});
  }, [loadGraph]);

  // Native folder drag-and-drop (Tauri only): dropping a folder anywhere opens
  // it as the repo. No-ops in the browser.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onFolderDrop(
      (path) => {
        setDragOver(false);
        setRepoPath(path);
        openRepo(path);
      },
      () => setDragOver(true),
      () => setDragOver(false),
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // openRepo is stable enough for this purpose; we intentionally subscribe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live updates: refresh the graph/status when the repo changes on disk.
  // The callback checks repoOpen via a ref so we don't refetch before a repo
  // is opened. The hook itself subscribes once and auto-reconnects.
  const repoOpenRef = useRef(repoOpen);
  repoOpenRef.current = repoOpen;
  useLiveUpdates(() => {
    if (repoOpenRef.current) refreshGraph();
  });

  // Debounced windowed re-query: when the scrubber changes the time window,
  // re-fetch the graph limited to [since, until]. Debounced so dragging doesn't
  // hammer the server. Skips the initial mount (timeWindow starts null).
  const windowDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!repoOpen || !timeWindow) return;
    if (windowDebounce.current) clearTimeout(windowDebounce.current);
    windowDebounce.current = setTimeout(() => {
      api.graph
        .get({ limit: GRAPH_NODE_LIMIT, since: timeWindow.since, until: timeWindow.until })
        .then((g) => {
          setGraph(g);
          setSelectedOid((prev) =>
            prev && g.nodes.some((n) => n.oid === prev) ? prev : (g.nodes[0]?.oid ?? null),
          );
        })
        .catch(() => {});
    }, 250);
    return () => {
      if (windowDebounce.current) clearTimeout(windowDebounce.current);
    };
  }, [timeWindow, repoOpen]);

  const handleSelectCommit = useCallback((oid: string) => {
    setSelectedOid(oid);
    // Special pseudo-nodes (working tree, stashes) are not commits — don't try
    // to fetch commit detail or a tree for them; their panels fetch their own data.
    if (isWorkingId(oid) || isStashId(oid)) {
      return;
    }
    setActivePanel("commit");
    // Load tree for this commit
    api.tree.list(oid).then(setTreeData).catch(() => {});
  }, []);

  const handleSelectFile = useCallback(async (path: string) => {
    setSelectedFilePath(path);
    setActivePanel("diff");
  }, []);

  // Files-tab file click: show the file's CONTENTS (not a diff), staying on the
  // Files tab. Separate from handleSelectFile (used by the commit panel), which
  // shows the diff for a changed file.
  const [contentsPath, setContentsPath] = useState<string | null>(null);
  const handleSelectFileContents = useCallback((path: string) => {
    setContentsPath(path);
  }, []);

  function handleRepoKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") openRepo();
  }

  if (!repoOpen || showPicker) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0d1117]">
        <div
          className={[
            "w-full max-w-md px-6 py-6 rounded-lg transition-colors",
            dragOver ? "ring-2 ring-blue-400 bg-blue-950/10" : "",
          ].join(" ")}
        >
          <div className="flex items-center gap-3 mb-8">
            <GitBranch size={32} className="text-blue-400" />
            <h1 className="text-2xl font-semibold text-[#e6edf3]">git-atlas</h1>
          </div>
          <p className="text-[#8b949e] mb-4 text-sm">
            {dragOver
              ? "Drop the folder to open it…"
              : showPicker
                ? "Open a different git repository."
                : "Enter the path to a local git repository to get started."}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              onKeyDown={handleRepoKeyDown}
              placeholder="/path/to/your/repo"
              className="flex-1 bg-[#161b22] border border-[#30363d] rounded-md px-3 py-2 text-sm text-[#e6edf3] placeholder:text-[#8b949e] outline-none focus:border-blue-500/60"
            />
            <button
              onClick={() => openRepo()}
              disabled={openingRepo || !repoPath.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors flex items-center gap-2"
            >
              {openingRepo ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              Open
            </button>
            {tauri && (
              <Tooltip primary="Browse for a folder">
                <button
                  onClick={async () => {
                    const picked = await pickDirectory();
                    if (picked) {
                      setRepoPath(picked);
                      openRepo(picked);
                    }
                  }}
                  disabled={openingRepo}
                  className="px-3 py-2 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-50 text-[#e6edf3] text-sm rounded-md border border-[#30363d] transition-colors flex items-center gap-2"
                >
                  Browse…
                </button>
              </Tooltip>
            )}
          </div>
          {repoError && (
            <div className="flex items-center gap-2 mt-3 text-sm text-red-400">
              <AlertCircle size={14} />
              {repoError}
            </div>
          )}

          {/* Recent repos */}
          {recentRepos.length > 0 && (
            <div className="mt-6">
              <p className="text-xs text-[#8b949e] mb-2">Recent</p>
              <div className="border border-[#30363d] rounded-md overflow-hidden">
                {recentRepos.map((path) => (
                  <button
                    key={path}
                    onClick={() => openRepo(path)}
                    className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] border-b border-[#30363d] last:border-0 transition-colors font-mono truncate"
                  >
                    {path}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Cancel — only when reopening over an already-open repo */}
          {showPicker && repoOpen && (
            <button
              onClick={() => {
                setShowPicker(false);
                setRepoError(null);
              }}
              className="mt-6 text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
            >
              ← Back to current repository
            </button>
          )}

          {/* Runtime hint */}
          <p className="mt-6 text-[11px] text-[#6e7681]">
            {tauri
              ? "Tip: drag a folder onto the window, or use Browse…"
              : "Tip: type or paste an absolute path. The native folder picker and drag-and-drop are available in the desktop app."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0d1117] text-[#e6edf3]">
      {/* Folder drag-and-drop overlay (Tauri) */}
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0d1117]/80 backdrop-blur-sm pointer-events-none">
          <div className="flex items-center gap-3 px-6 py-4 rounded-lg border-2 border-dashed border-blue-400 bg-[#161b22]">
            <FolderOpen size={20} className="text-blue-400" />
            <span className="text-sm text-[#e6edf3]">Drop folder to open repository</span>
          </div>
        </div>
      )}
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 h-10 border-b border-[#30363d] shrink-0 bg-[#161b22]">
        <GitBranch size={16} className="text-blue-400" />
        <span className="text-sm font-semibold text-[#e6edf3]">git-atlas</span>
        <span className="text-[#8b949e] text-xs font-mono truncate">{repoPath}</span>
        <Tooltip primary="Open a different repository" className="ml-auto shrink-0">
          <button
            onClick={() => {
              api.repo.recent().then(setRecentRepos).catch(() => {});
              setShowPicker(true);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] hover:border-[#58a6ff]/50 rounded-md transition-colors"
          >
            <FolderOpen size={13} />
            Change repo
          </button>
        </Tooltip>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 min-h-0">
        {/* Left: commit graph */}
        <div className="flex w-[55%] min-w-0 border-r border-[#30363d]">
          {/* Vertical time scrubber (only when we have a valid time range) */}
          {graph && timeBounds && (
            <TimeScrubber
              newestTs={timeBounds.newest}
              oldestTs={timeBounds.oldest}
              since={timeWindow?.since ?? timeBounds.oldest}
              until={timeWindow?.until ?? timeBounds.newest}
              onChange={(since, until) => setTimeWindow({ since, until })}
            />
          )}
          <div className="flex flex-col flex-1 min-w-0">
            {/* Status bar — always shown when a graph is loaded. Range + counts,
                and a Home button (reset time + jump to HEAD). Sits in normal flow
                above the graph so the absolute controls overlay doesn't cover it. */}
            {graph && timeBounds && (
              <WindowBanner
                newest={timeWindow?.until ?? timeBounds.newest}
                oldest={timeWindow?.since ?? timeBounds.oldest}
                shownCount={graph.nodes.length}
                totalCount={graph.nodes.length + (graph.before_count ?? 0) + (graph.after_count ?? 0) + (graph.hidden_count ?? 0)}
                beforeCount={graph.before_count ?? 0}
                afterCount={graph.after_count ?? 0}
                onHome={() => {
                  // Reset any time filter and jump to HEAD (main/master fallback).
                  setTimeWindow(null);
                  const head =
                    graph.refs.find((r) => r.is_head) ??
                    graph.refs.find((r) => r.name === "main" || r.name === "master");
                  if (head) setJumpToOid(head.oid);
                }}
              />
            )}
            <div className="relative flex flex-col flex-1 min-h-0">
            {/* Graph controls overlay: find box + branch control toggle.
                The branch panel accordions down directly under the Branches
                button (same left-anchored column). */}
            {graph && (
              <div className="absolute top-2 left-2 z-30 flex flex-col gap-1">
                {/* Backing surface: a semi-opaque, blurred panel behind the top
                    control row so graph nodes/dots don't shine through the gaps
                    between buttons. The Branches accordion sits BELOW this and
                    keeps its own panel styling. */}
                <div className="flex items-center gap-2 rounded-md bg-[#161b22] p-1">
                  <FindRefBox refs={graph.refs} onJump={(oid) => setJumpToOid(oid)} />
                  <Tooltip primary="Show/hide branches">
                    <button
                      onClick={() => setShowBranchControl((s) => !s)}
                      className={controlButtonClass(showBranchControl)}
                    >
                      <GitBranch size={12} />
                      Branches
                    </button>
                  </Tooltip>
                  <ToggleSwitch
                    checked={switchOn}
                    pending={viewModePending}
                    onChange={(on) => {
                      setSwitchOn(on); // urgent: paints the switch immediately
                      startViewModeTransition(() =>
                        setViewMode(on ? "active" : "full"),
                      );
                    }}
                    title="Fold merged side-branches behind their merge nodes. Off shows the full DAG with every branch expanded."
                  >
                    <GitMerge size={12} />
                    Collapse merged branches
                  </ToggleSwitch>
                </div>
                {showBranchControl && (
                  <BranchControl
                    groups={groupBranches(branchesFromRefs(graph.refs))}
                    visibility={branchVis}
                    onCycle={cycleBranch}
                    onCycleGroup={cycleBranches}
                    trunkBranch={trunkBranch}
                    onSetTrunk={setTrunkBranch}
                  />
                )}
              </div>
            )}
            {graphLoading ? (
              <div className="flex items-center justify-center h-full text-[#8b949e]">
                <Loader2 size={20} className="animate-spin mr-2" />
                Loading graph…
              </div>
            ) : graphError ? (
              <div className="flex items-center justify-center h-full text-red-400 text-sm gap-2">
                <AlertCircle size={16} /> {graphError}
              </div>
            ) : graph ? (
              <CommitGraph
                key={repoPath}
                graph={graph}
                status={status}
                selectedOid={selectedOid}
                onSelectCommit={handleSelectCommit}
                branchVisibility={branchVis}
                jumpToOid={jumpToOid}
                onJumpConsumed={() => setJumpToOid(null)}
                viewMode={viewMode}
                trunkBranch={trunkBranch}
              />
            ) : null}
            </div>
          </div>
        </div>

        {/* Right: detail panels */}
        <div className="flex flex-col w-[45%] min-w-0">
          {selectedOid && isWorkingId(selectedOid) ? (
            <>
              <div className="flex items-center gap-2 px-4 h-9 border-b border-[#30363d] bg-[#161b22] shrink-0">
                <span className="text-xs font-semibold text-emerald-300">Working tree</span>
                <span className="text-[10px] text-[#8b949e]">uncommitted changes</span>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <WorkingPanel />
              </div>
            </>
          ) : selectedOid && isStashId(selectedOid) ? (
            <>
              <div className="flex items-center gap-2 px-4 h-9 border-b border-[#30363d] bg-[#161b22] shrink-0">
                <span className="text-xs font-semibold text-amber-300">
                  stash@{`{${stashIndexFromId(selectedOid)}}`}
                </span>
                <span className="text-[10px] text-[#8b949e]">stashed changes</span>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <StashPanel index={stashIndexFromId(selectedOid)} />
              </div>
            </>
          ) : (
            <>
              {/* Panel tab bar */}
              <div className="flex border-b border-[#30363d] bg-[#161b22] shrink-0">
                {(["commit", "diff", "tree", "search"] as RightPanel[]).map((panel) => {
                  const icons: Record<RightPanel, React.ReactNode> = {
                    commit: <GitCommit size={13} />,
                    diff: <span className="text-[10px] font-mono">±</span>,
                    tree: <FolderOpen size={13} />,
                    search: <Search size={13} />,
                  };
                  const labels: Record<RightPanel, string> = {
                    commit: "Commit",
                    diff: "Diff",
                    tree: "Files",
                    search: "Search",
                  };
                  return (
                    <button
                      key={panel}
                      onClick={() => setActivePanel(panel)}
                      className={[
                        "flex items-center gap-1.5 px-4 py-2 text-xs border-b-2 transition-colors",
                        activePanel === panel
                          ? "border-blue-400 text-blue-400"
                          : "border-transparent text-[#8b949e] hover:text-[#e6edf3]",
                      ].join(" ")}
                    >
                      {icons[panel]}
                      {labels[panel]}
                    </button>
                  );
                })}
              </div>

              {/* Panel content */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {activePanel === "commit" && selectedOid && (
                  <CommitPanel
                    oid={selectedOid}
                    onSelectFile={handleSelectFile}
                    onSelectCommit={setSelectedOid}
                  />
                )}
                {activePanel === "diff" && selectedOid && (
                  <DiffViewerWrapper oid={selectedOid} filePath={selectedFilePath} />
                )}
                {activePanel === "tree" && selectedOid && treeData && (
                  <div className="flex flex-col h-full min-h-0">
                    <div className="flex-1 min-h-0 overflow-auto border-b border-[#30363d]">
                      <FileBrowser
                        entries={treeData.entries}
                        onSelectFile={handleSelectFileContents}
                        selectedPath={contentsPath}
                      />
                    </div>
                    <div className="flex-1 min-h-0">
                      {contentsPath ? (
                        <FileViewer oid={selectedOid} path={contentsPath} />
                      ) : (
                        <div className="flex items-center justify-center h-full text-xs text-[#8b949e]">
                          Select a file to view its contents
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {activePanel === "search" && (
                  <SearchPanel
                    commitOid={selectedOid}
                    onSelectFile={handleSelectFile}
                  />
                )}
                {!selectedOid && activePanel !== "search" && (
                  <div className="flex items-center justify-center h-full text-sm text-[#8b949e]">
                    Select a commit in the graph
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Loads and displays diff for a commit, optionally filtered to a single file */
function DiffViewerWrapper({ oid, filePath }: { oid: string; filePath: string | null }) {
  const [diff, setDiff] = useState<import("./api/client").DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.diff.forCommit(oid)
      .then((d) => {
        if (filePath) {
          setDiff({ ...d, files: d.files.filter((f) => f.path === filePath) });
        } else {
          setDiff(d);
        }
      })
      .finally(() => setLoading(false));
  }, [oid, filePath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[#8b949e]">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  if (!diff) return null;
  return <DiffViewer diff={diff} />;
}
