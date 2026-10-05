# Renderer freeze during long Agent runs

## Symptom

During a 65-minute Qwen Deep Agent run (144 actions, 127 reasoning turns, 403 K characters of reasoning, 453 K characters
of persisted timeline) the window progressively stopped responding: first intermittent freezes that recovered, then a
frozen Context popover, a blank surface after the window was covered and revealed, and no recovery after the run ended.
The model, the Rust agent and the tools kept working: files in the project kept receiving new timestamps.

## Evidence

- The run's data survived in SQLite. The main process finished and persisted it normally (`analysis_runs.completed_at`
  22:19:40), so the backend and the main process were healthy. There are no Chromium crash reports and the main process
  has no blocking calls apart from a small synchronous logger. The renderer is where the time went.
- The persisted run was replayed through the production renderer in headless Chrome
  (`scripts/renderer-replay/`), with the same reasoning and tool stream the main process emits, at 250 events/s (about
  four times the real rate; per-frame cost depends on history size, not on the rate).
- Baseline build, per 25 K characters of reasoning: main-thread lag p95 2 ms up to 125 K characters, then a steady climb;
  in the 350–375 K window a **6.7 s stall** (94 long tasks, worst frame 6.6 s). The DOM grew to 29 K nodes.
- The CPU profile of the degraded region attributes ~5.2 s of self time to one function: the `useLayoutEffect` in `App`
  that follows the stream, and the rest of the stall to the layout and style work it triggers.

## Root causes

1. **Forced synchronous layout on every update.** The follow-scroll effect read `scrollHeight` in the commit phase,
   which flushes style and layout of the whole conversation, on every streamed update and every tool event. The cost
   grew with the DOM, and the DOM held every paragraph and tool row of the run.
2. **A state-ordering race that fragmented the timeline.** Reasoning deltas are batched until the next animation
   frame; tool events are applied immediately. A tool call follows its reasoning within the same frame, so the activity
   entry landed first and the remaining reasoning fragments then created a *second entry with the same id*. The live
   timeline had 4 172 sections for what is 1 318 paragraphs (persisted), with duplicate React keys (`reasoning-1-0`
   twice), so nodes could not be reused and the DOM kept growing (29–33 K nodes against 9 K). Sentences were also broken
   into separate "Thought" blocks, and every paragraph of a finished thought was labelled "Thinking" because the
   component tested `!completedAt` instead of the item's own `live` flag.
3. **Work proportional to history per frame.** Each frame re-split all reasoning text into paragraphs and re-rendered the
   timeline; every store update re-rendered five components that subscribed to the whole state; `generationState` was
   re-set on every token, which notifies subscribers even when the value is the same; and the whole run snapshot was
   re-sent over IPC for every terminal output line.
4. **The end of a run remounted everything.** `done` replaces the streaming message with the persisted one, so a 1 318
   thought timeline was parsed and highlighted at once (1.1–1.5 s), and reopening the conversation did the same.

## Why the backend kept working, and the blank window

The agent loop, llama.cpp and the tools live in other processes; none of them waits for the renderer. Only painting
and input handling are on the renderer's main thread, which was busy. A window that is covered or minimized discards its
frame; when it is revealed again the renderer must produce a new frame, and a starved main thread cannot, so the surface
stays blank until the backlog clears. That is the same cause, not a separate bug (a repaint after a full invalidation
takes 176–183 ms on the large DOM and 25–49 ms after the fix).

## Fix

- Follow-scroll is scheduled once per animation frame and no longer reads layout in the commit phase.
- `appendReasoningFragments` merges a fragment into the entry that holds its position wherever that entry is, so one
  thought is one entry with one id. Unchanged entries keep their identity.
- Finished thoughts are split once (cached per immutable event), each thought is a memoized component, and
  `content-visibility: auto` keeps off-screen rows out of layout and paint. Finished text far from the viewport is shown
  as plain text and parsed into Markdown when it approaches it, so mounting a long run costs what is visible.
- Components subscribe to the fields they use (`useShallow`); unchanged `generationState` no longer notifies; the main
  process re-sends the run snapshot only when an action appears or finishes, not for every output line.
- The Context popover's Elapsed value has its own once-a-second ticker that runs only while the popover is open during a run.

Nothing is dropped or hidden: all reasoning, tool rows and history are still in the DOM, selectable and searchable, and
persistence is unchanged.

## Measurements (same run, same stream)

| | baseline | fixed |
|---|---|---|
| worst main-thread stall during the run | 6 687 ms | 87 ms (worst frame) |
| lag p95 at 350–400 K characters | 37–129 ms | 5 ms |
| sections / DOM nodes at the end (live view) | 4 172 / 29–33 K | 1 318 / 9.3 K (6.9 K lazy) |
| `done` swap (main thread blocked) | 1 454 ms | 57 ms |
| cold load of the persisted run | 1 690 ms | 258 ms |
| repaint after full invalidation | 176–183 ms | 25–49 ms |

Browser measurements use headless Chrome with software rendering; the numbers show the shape and the order of magnitude,
not Electron on a GPU.

## Guarding it

- `src/shared/streaming-load.test.ts` streams a long run (40 000 reasoning fragments, tool events with output lines)
  through the real store and checks structure rather than timing alone: unique ids, one reasoning entry per turn, no text
  lost, finished paragraphs reused across renders, store notifications far below the event count, and flat per-turn work.
  It fails against the previous reducer.
- `scripts/renderer-replay/` replays any persisted run in headless Chrome and prints per-25 K-character checkpoints
  (`node export-run.mjs copy-of.db > run.json`; `RUN_JSON=run.json node replay.mjs`; `FINISH=1` adds the `done` swap and
  repaint probes; `node load.mjs` measures a cold load).

## Steering and pause entries

Pending steering is a renderer-only timeline entry with position `MAX_SAFE_INTEGER` (so it sorts last and never counts as
the "live" reasoning row); when `steering_applied` arrives the entry is updated in place with its real position. The
`paused` marker is a normal timeline entry appended at `++position`. Neither adds per-delta work: both go through the
same coalesced stream path, and `thinking-timeline.test.ts` covers ordering with interleaved reasoning.
