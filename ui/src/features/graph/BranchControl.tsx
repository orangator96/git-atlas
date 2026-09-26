import { useState } from "react";
import { Eye, EyeOff, ChevronsDownUp, Minus, ChevronDown, ChevronRight, Pin } from "lucide-react";
import type { BranchInfo, BranchVisibility } from "./branches";
import { nextVisibility } from "./branches";
import type { BranchGroup } from "./branchGroups";
import { isPaired } from "./branchGroups";
import Tooltip from "../../components/Tooltip";

/**
 * Branch visibility control. Renders one row per branch group:
 *  - A **paired** group (a local branch + its tracked remote) is collapsed by
 *    default to a single row: the group state icon + the local name + a small
 *    orange dot indicating a tracked remote exists. Clicking the row cycles
 *    BOTH members in lockstep. A disclosure chevron expands the row in place to
 *    reveal per-member controls (local + remote) for independent toggling.
 *  - A **singleton** group shows a single name + a single control.
 *
 * Each control cycles the tri-state Expanded → Collapsed → Hidden. The panel
 * accordions down from the "Branches" toggle button (positioned by the parent);
 * closing is handled by that button, so there's no in-panel header/close.
 */
export default function BranchControl({
  groups,
  visibility,
  onCycle,
  onCycleGroup,
  trunkBranch = null,
  onSetTrunk,
}: {
  groups: BranchGroup[];
  visibility: Map<string, BranchVisibility>;
  onCycle: (name: string) => void;
  onCycleGroup: (names: string[]) => void;
  /** Branch currently pinned to lane 0 (the trunk spine), or null for auto. */
  trunkBranch?: string | null;
  /** Pin `name` to lane 0, or clear to auto when `name` is null. */
  onSetTrunk?: (name: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  // Which paired groups (keyed by local branch name) are expanded to show their
  // per-member controls. Collapsed by default — the common case is lockstep.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  const q = filter.toLowerCase();
  const shown = groups.filter((g) =>
    g.members.some((m) => m.toLowerCase().includes(q)),
  );

  // Each state's glyph, centered in a fixed-size box so every row's icon
  // occupies the same footprint — names line up (no "wavy" left edge) and the
  // thinner collapse chevron reads at parity with the eye glyphs.
  const icon = (v: BranchVisibility) => (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      {v === "expanded" ? (
        <Eye size={13} className="text-emerald-400" />
      ) : v === "collapsed" ? (
        <ChevronsDownUp size={14} className="text-purple-300" />
      ) : (
        <EyeOff size={13} className="text-[#6e7681]" />
      )}
    </span>
  );

  /** The verb for the action that lands the branch in state `v`. */
  const actionVerb = (v: BranchVisibility) =>
    v === "expanded" ? "expand" : v === "collapsed" ? "collapse" : "hide";

  /**
   * The muted "next action" line for a branch-state control's tooltip: the verb
   * for the state a click will land in, plus that state's glyph. Fed to the
   * shared `Tooltip` as its `secondary` content.
   */
  const actionHint = (v: BranchVisibility) => {
    const next = nextVisibility(v);
    return (
      <>
        click to {actionVerb(next)}
        {icon(next)}
      </>
    );
  };

  /**
   * A single per-member control (icon + name), cycling that branch alone.
   * `label` overrides the displayed text (used to shorten a redundant remote
   * name to just its remote prefix); the full name still shows in the tooltip.
   */
  const memberButton = (b: BranchInfo, label?: string) => {
    const v = visibility.get(b.name) ?? "hidden";
    return (
      <div key={b.name} className="flex items-center gap-0.5 w-full">
        <Tooltip primary={b.name} mono secondary={actionHint(v)} className="flex-1 min-w-0">
          <button
            onClick={() => onCycle(b.name)}
            className="flex items-center gap-1.5 min-w-0 w-full px-1.5 py-0.5 rounded hover:bg-[#30363d] text-left"
          >
            {icon(v)}
            <span
              className={[
                "font-mono truncate flex-1",
                v === "hidden" ? "text-[#6e7681]" : "text-[#e6edf3]",
              ].join(" ")}
            >
              {b.isHead ? "● " : ""}
              {label ?? b.name}
            </span>
          </button>
        </Tooltip>
        {trunkButton(b.name)}
      </div>
    );
  };

  /**
   * Shorten a remote name that just mirrors the local one: `origin/main`
   * paired with local `main` → `origin`. Any other remote name is unchanged.
   */
  const remoteLabel = (remoteName: string, localName: string) => {
    const slash = remoteName.lastIndexOf("/");
    if (slash > 0 && remoteName.slice(slash + 1) === localName) {
      return remoteName.slice(0, slash);
    }
    return remoteName;
  };

  /**
   * A small "pin to lane 0" (trunk) control for a branch. Highlighted when this
   * branch is the current trunk; clicking it pins the branch, clicking the
   * active one clears back to auto (main → master → HEAD). Only rendered when
   * the parent supplies `onSetTrunk`.
   */
  const trunkButton = (name: string) => {
    if (!onSetTrunk) return null;
    const active = trunkBranch === name;
    return (
      <Tooltip
        primary={active ? "Pinned to lane 0 (trunk)" : "Pin to lane 0 (trunk)"}
        secondary={active ? "click to unpin (auto)" : "click to make this the mainline spine"}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSetTrunk(active ? null : name);
          }}
          aria-pressed={active}
          className={[
            "ml-1 shrink-0 inline-flex h-4 w-4 items-center justify-center rounded transition-colors",
            active
              ? "text-blue-300 bg-blue-500/25 ring-1 ring-blue-600/50"
              : "text-[#6e7681] hover:text-blue-300 hover:bg-[#30363d]",
          ].join(" ")}
        >
          <Pin size={11} className={active ? "fill-blue-400/40" : ""} />
        </button>
      </Tooltip>
    );
  };

  return (
    <div className="w-[32rem] max-h-[70%] flex flex-col rounded-md border border-[#30363d] bg-[#161b22] shadow-lg text-xs">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter branches…"
        className="m-2 px-2 py-1 bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] placeholder:text-[#6e7681] outline-none focus:border-blue-500/60"
      />
      <div className="overflow-auto px-1 pb-2">
        {shown.map((g) => {
          if (isPaired(g) && g.local) {
            // Collapsed by default: one row for the local branch, with a group
            // state icon (the members' shared state, or a "mixed" marker when
            // they've diverged) and an orange remote pill sitting right after
            // the name. The pill shows the remote count when >1 plus an
            // expand/collapse chevron, and IS the disclosure control — clicking
            // it expands per-member rows (local + each remote) in place for
            // independent toggling. When open, the children get a connecting
            // left rule so parent and members read as one unit. Clicking the
            // icon or name cycles ALL members together (the common case).
            const local = g.local;
            const remotes = g.remotes;
            const lv = visibility.get(local.name) ?? "hidden";
            const states = g.members.map((m) => visibility.get(m) ?? "hidden");
            const mixed = states.some((s) => s !== states[0]);
            const allHidden = states.every((s) => s === "hidden");
            const isOpen = expanded.has(local.name);
            const remoteNames = remotes.map((r) => r.name).join(", ");
            return (
              <div key={local.name} className="rounded">
                <div className="relative flex items-center gap-0.5 px-1 py-1">
                  <Tooltip
                    primary={`${local.name} + ${remoteNames}`}
                    mono
                    secondary={actionHint(lv)}
                  >
                    <button
                      onClick={() => onCycleGroup(g.members)}
                      className="shrink-0 p-1 rounded hover:bg-[#21262d]"
                    >
                      {mixed ? (
                        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[#8b949e]">
                          <Minus size={13} />
                        </span>
                      ) : (
                        icon(lv)
                      )}
                    </button>
                  </Tooltip>
                  <Tooltip
                    primary={`${local.name} + ${remoteNames}`}
                    mono
                    secondary={actionHint(lv)}
                  >
                    <button
                      onClick={() => onCycleGroup(g.members)}
                      className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 rounded hover:bg-[#30363d] text-left"
                    >
                      <span
                        className={[
                          "font-mono truncate",
                          allHidden ? "text-[#6e7681]" : "text-[#e6edf3]",
                        ].join(" ")}
                      >
                        {local.isHead ? "● " : ""}
                        {local.name}
                      </span>
                    </button>
                  </Tooltip>
                  <Tooltip
                    primary={remoteNames}
                    mono
                    secondary={`${remotes.length} remote-tracking branch${remotes.length > 1 ? "es" : ""} — click to ${isOpen ? "hide" : "view"}`}
                  >
                    <button
                      onClick={() => toggleExpanded(local.name)}
                      className={[
                        "ml-1 shrink-0 inline-flex h-4 items-center justify-center gap-0.5 rounded-full pl-1.5 pr-1",
                        "bg-orange-500/25 text-orange-300 ring-1 ring-orange-700/50",
                        "text-[10px] font-medium leading-none hover:bg-orange-500/40",
                      ].join(" ")}
                      aria-expanded={isOpen}
                    >
                      <span className="inline-flex w-2 justify-center tabular-nums">
                        {remotes.length}
                      </span>
                      {isOpen ? (
                        <ChevronDown size={11} className="shrink-0" />
                      ) : (
                        <ChevronRight size={11} className="shrink-0" />
                      )}
                    </button>
                  </Tooltip>
                  {/* spacer keeps the row full-width so it aligns with others */}
                  <div className="flex-1" />
                  {trunkButton(local.name)}
                </div>
                {isOpen && (
                  <div className="ml-3 mr-3 flex min-w-0 flex-col gap-0.5 rounded border border-l-2 border-[#30363d] border-l-[#6e7681] bg-[#1c2128] pb-1 pl-3 pr-1 pt-1">
                    {memberButton(local)}
                    {remotes.map((r) => memberButton(r, remoteLabel(r.name, local.name)))}
                  </div>
                )}
              </div>
            );
          }
          // Singleton — a lone local branch or bare remote-tracking branch. The
          // branch's own state icon sits in the group column (where paired rows
          // put their group control); the name left-justifies in the member
          // area, aligned with paired members.
          const b = g.local ?? g.remotes[0];
          if (!b) return null;
          const v = visibility.get(b.name) ?? "hidden";
          return (
            <div key={b.name} className="flex items-center gap-0.5">
              <Tooltip primary={b.name} mono secondary={actionHint(v)} className="flex-1 min-w-0">
                <button
                  onClick={() => onCycle(b.name)}
                  className="flex w-full items-center gap-1 px-1 py-1 rounded hover:bg-[#21262d] text-left"
                >
                  <span className="shrink-0 p-1">{icon(v)}</span>
                  <span
                    className={[
                      "font-mono truncate flex-1 px-1.5",
                      v === "hidden" ? "text-[#6e7681]" : "text-[#e6edf3]",
                    ].join(" ")}
                  >
                    {b.isHead ? "● " : ""}
                    {b.name}
                  </span>
                </button>
              </Tooltip>
              {trunkButton(b.name)}
            </div>
          );
        })}
        {shown.length === 0 && (
          <div className="px-2 py-2 text-[#6e7681]">No branches match.</div>
        )}
      </div>
    </div>
  );
}
