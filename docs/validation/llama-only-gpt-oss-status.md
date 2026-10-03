# Llama-only / GPT-OSS paused validation handoff

Work was paused at the user's request on 2026-10-04. No feature merge, push,
or release approval has occurred. Do not treat a single `finish_reason=stop`
as proof of natural Agent convergence. The revised acceptance permits model
semantic-quality differences, but still requires correct evidence/state
invariants and successful live architecture/runtime gates without loops.

## Git preservation

- Initial clean branch: `v2-migration` at
  `cc165b647541b30b72c62d35446d150a9ffeec28`.
- Validated Deep/Fast tip:
  `9aeef13ffd1f6789bbff76bfc698d7417c076cc6`.
- History-preserving merge, still the local `v2-migration` tip:
  `5df8e6a0042d442c661879b3461f4f8dd46e376f`.
- Current branch: `feat/llama-only-gpt-oss`.
- Existing feature commits:
  `026ab75356ca5fdb1bbe38f32ad6dfdd32821645` (source-line evidence fix),
  `bae5a0729eaf5c3a8f4c74bfdf1b7c1eea5774db` (llama-only/GPT-OSS), and
  `77a56ecd60ec2959c69d52a5adf6d439433dc707` (historical blocked report).
- Validated generic continuation was checkpointed locally as
  `b8d9fffea8a06007b51ad29cd893bd8868ccef10`.
- Remote observed at pause:
  `3495c4258e615fd2e7c311618bb00ac21c4275fa` for `origin/v2-migration`.
  It is a preserved ancestor; no remote update was made.
- Origin: `git@github-kushch:Kushch-Yaroslav/local-ai-desctop.git`.

## Evidence investigation and completed generic changes

The earlier 17-turn GPT-OSS write supplied only JSON keys `action` and
`finding`. "Confirmed" and citations were prose within `finding`, not
structured fields. The stored entry was unclassified, with empty evidence,
and its finding was normalized to the existing 700-character limit. It was
not a structurally Confirmed entry accepted without evidence.

Real observation receipts were exposed in provider tool messages. Keep the
historical runs distinct: run `1791059210204` used observation 10 for a
directory; line-mapped run `1791059751588` used observation 10 for
`register-ipc.ts` lines 425-512. Valid references do not establish semantic
entailment or validate invented line citations.

A separate genuine invariant gap was fixed generically:

- Effective Confirmed writes require nonempty evidence resolving known
  observation IDs or exact observed source paths in the durable transcript.
  Unknown observation tokens reject even alongside a valid source path.
- Record/update, promotion, and superseding validate a cloned candidate
  before mutation, revision changes, superseded-entry invalidation, write-cap
  consumption, or cadence reset. Errors are explicit recoverable tool errors.
- Missing/invalid action, finding, or required ID fail without mutation.
  Only successful memory mutations reset checkpoint cadence.
- Active Confirmed saved memory is validated before inference. Invalid
  saved memory errors explicitly; unclassified legacy and invalidated
  historical entries are retained.
- Existing reference normalization, sentence punctuation, spaced/Unicode
  source paths, compaction, durable replay, and same-observation updates are
  covered. No model-specific semantic grading or citation rewriting was added.

Qwen exposed a second generic interoperability defect: a root `oneOf`
becomes a union in this llama.cpp schema AST, while native XML parameter
enumeration requires an object root. Controlled old/new schema probes
demonstrated empty parameters versus a correct structured call. The
advertised schema now has a flat object root; runtime action validation
remains authoritative.

## Actual latest live results

All runs used the real compiled backend, Rust bridge, primary sidecar,
isolated launcher and SQLite backup, full application output budget, and
unmodified Deep profiles. Context was 32K, not every advertised maximum.

| Model | Deep trajectory | Other live gates |
| --- | --- | --- |
| Qwen3.8-27B Q4_K_M | 86 turns, 125 calls, 14 memory updates, 8 compactions, 13 recoverable errors; one natural final, no finalization lifecycle transition | Fast 17 turns/20 calls; Chat Fast/Deep streaming, direct structured tool/result roundtrip, persisted-memory follow-up, Chat/Agent cancellation and idle-slot cleanup passed |
| GLM-4.7-Flash Q4_K | 62 turns, 213 calls, 45 memory updates, 4 compactions, 41 recoverable errors and 7 blocked approvals; one natural final, no finalization lifecycle transition | Fast 8 turns/16 calls; Chat, direct protocol, persisted-memory follow-up, cancellation and cleanup passed |
| GPT-OSS-20B MXFP4 | 129 turns, 128 calls, 1 memory update, 3 compactions, 87 tool errors; one final only after the 128-turn investigation safeguard | Fast 5 turns/4 calls, Chat/streaming reasoning separation, direct tool/result roundtrip, cancellation and cleanup passed; persisted unclassified memory replay completed in 2 turns |

GLM's original scratch harness exited 1 because its pairing assertion omitted
`approval_required` as an outcome. The canonical/provider traces contain real
`{"error":"approval required"}` tool messages for all seven calls. The harness
was corrected, the original completed Deep trace revalidated, and remaining
live gates resumed successfully. This was not an application failure or a
regenerated Deep answer. GLM nevertheless made false semantic absence/IPC
claims from guessed names/paths; these are not proof of harness corruption.

### GPT-OSS unresolved convergence/interop investigation

Run `revised-gpt-oss-20b-deep-1791066423866` made 82 `task_memory` calls:
one view, one accepted unclassified `finding: "test"` record, 79 explicit
"requires finding" failures, and one rejected Confirmed write without
evidence. Only the valid unclassified record changed memory, to revision 1.
The replay test therefore proves structural persistence, not useful verified
analysis memory.

Many failed calls contained action/ID/status/supersedes but no finding; some
embedded intended JSON fields in the supersedes string. The durable
`lifecycle_transition` records `turn_budget_exhausted` at turn 129. The final
provider request had no tools. The scratch report's exit 0 proves its limited
protocol checks, not the stronger no-loop/natural-completion gate. That gate
has not passed for GPT-OSS.

Controlled exact-schema probes gave different results:

- Four-field action/evidence/finding/status probe returned all four fields.
- Eight-field probe's reasoning explicitly planned all eight named fields,
  but its actual tool arguments contained only action, ID and supersedes.
- Read-only inspection of llama.cpp
  `common/json-schema-to-grammar.cpp`, `_build_object_rule` (lines 698-797),
  establishes ordered optional-property branches: selecting a later optional
  property excludes earlier ones. This is a concrete interoperability lead,
  not yet a proven complete cause or justification for a production patch.
- A reordered-properties control was interrupted safely by the user pause.
  Shell 387 exited 1 (`UND_ERR_SOCKET`) after the owned server stopped.
  There is no result to interpret or claim as a completed comparison.

Do not force model behavior, add a model-name patch, or weaken Deep to make
this pass. Investigate the remaining native schema/argument issue before
deciding whether a safe generic fix is justified.

## Runtime/model identity and isolation

- Official source: `ggml-org/gpt-oss-20b-GGUF`, Apache-2.0 MXFP4 GGUF.
- File: `/media/yaroslav/DATA/llama-models/gpt-oss-20b-MXFP4.gguf`,
  12,109,566,624 bytes; SHA-256
  `27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901`.
- Embedded native Jinja/Harmony; trained context 131,072.
- Runtime: `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`,
  `0.4.1-dev`, commit `d1d3c33`; live executable SHA-256
  `d7061d202c2ee116fa826963d781cef67d2b36b18805c5d81322d11ef9f52e1b`.
- GPT actual arguments: `--log-verbosity 5 -m <file> --alias gpt-oss:20b
  --host 127.0.0.1 --port 18081 --ctx-size 32768 --gpu-layers 999
  --flash-attn on --cache-type-k f16 --cache-type-v f16 --kv-offload
  --parallel 1 --spec-type none --jinja --reasoning on
  --reasoning-format auto --no-warmup`.
- Qwen used Q8_0 cache/MTP; GLM used F16/Jinja/no speculation. Exact arguments
  and metadata are archived separately for each model.
- Live `/proc/<pid>/exe` path and disk/live SHA equality verified primary
  `rust-agent/target/debug/local-ai-agent-runtime`:
  `52d1108b3aca50892fc885f0c97e4ff291b76d4952de870719a32c3a3e3ed90f`,
  mtime `2026-10-03T21:16:08.034Z`.
  Qwen/GPT identities are archived. GLM original Deep spawn assertions passed
  but its PID object was not archived before the harness assertion; resumed
  Fast/cancel/replay identities are archived.
- Model inventory and user Ollama data were read-only, not deleted/migrated.
  Qwen's existing GGUF symlink is model data, not daemon integration.
- Original user DB SHA remained
  `6cab12452f167b0bbabd92ac8351d6aa6900a3712c7b5bd70f0858d0f47d8525`.
  Only SQLite-backup copies were used. No benchmark source writes were made.

## Automated validation, removal audit, and pending work

Frozen Rust source passed 117 unit and 18 integration tests, fmt and diff
checks. Clippy exited 0 with advisory/pedantic warnings, not warning-free.
The existing npm build/typecheck, compiled Max Context/backend/database/
runtime/launcher suites, bridge/thinking/generation/diagnostic guards and
changed-file TypeScript ESLint passed earlier. After the last two Rust-only
helper changes the primary sidecar was rebuilt and Rust tests rerun; one
final whole-snapshot npm build and selected final regressions remain pending.
No new test/build was started after the pause request.

Tracked executable source, Rust, launchers, scripts, package/config and active
persistence were audited for `ollama`, `11434`, `OLLAMA_`, and `keep_alive`.
No application Ollama inference wiring remains. Historical references remain
in clearly historical records. Nine stale ignored compiled JS artifacts from
deleted Ollama/V1 sources were removed; source changes were not discarded.
Recheck generated outputs after the final build.

Remaining work:

1. Resume the native optional-property/Task Memory argument investigation;
   compare controlled requests with equal settings before drawing a cause.
2. Only implement a demonstrated safe generic fix, with deterministic tests,
   if warranted; rerun affected live gates. GPT Deep no-loop gate is open.
3. Update README's obsolete validation paragraph and finalize this record.
4. Run final Rust/TS/runtime/Max Context, lint/fmt and `npm run build` once on
   the final source snapshot, using compiled selectors rather than repeating
   wrappers that each rebuild.
5. Only after all revised gates pass, normally merge into `v2-migration`,
   run final merged-branch regressions, push only the explicit V2 ref
   non-force with mirror/followTags disabled, and verify remote SHA.
6. Verify/report actual `dist/main/index.js`, `dist/preload/index.js`,
   `dist/renderer/index.html` and asset names. No installer/AppImage target
   exists; no release or packaging claim has been made.

## Exact safe resume point

Start with this read-only command in a new session:

```bash
cd /media/yaroslav/DATA/local-ai-desktop
git status --short &&
git branch --show-current &&
git log -3 --format='%H %s' &&
cat docs/validation/llama-only-gpt-oss-status.md
```

Persistent evidence root:
`/home/yaroslav/.copilot/session-state/477fe953-a284-4202-901b-3f254364043e/files`.
Read `revised-live/gpt-oss/task-memory-full-schema-probe.json`,
`task-memory-schema-probe.json`, `forensics-validated.jsonl`,
`validation/report.json`, and the native grammar source above next.
Do not mistake the interrupted reordered probe for evidence.

After inspecting current processes/resources and receiving authorization to
resume model tests, the exact owned GPT launcher command is:

```bash
LOCAL_AI_RUNTIME_ROOT=/home/yaroslav/.copilot/session-state/477fe953-a284-4202-901b-3f254364043e/files/revised-live/gpt-oss \
LOCAL_AI_LLAMA_PORT=18081 LOCAL_AI_LAUNCHER_HEADLESS=1 \
LOCAL_AI_LLAMA_MODEL_ID=gpt-oss:20b LOCAL_AI_LLAMA_CONTEXT=32768 \
bash run-local-ai-desktop-llama-cpp-mtp.sh
```

All validated raw, bridge, provider, memory, final, replay, identity and
resource records remain under `revised-live/{qwen,glm,gpt-oss}`. Helpers
`revised-live-regression.js`, `revised-live-replay.js`,
`probe-llama-model.js`, and `probe-memory-schema.js` remain outside the repo.
Strengthen the scratch gate to inspect actual lifecycle finalization and
tool availability, not just the request policy's phase label.

## Pause cleanup

All owned model launchers, servers, sidecars and test helpers were stopped.
GPT launcher/server PIDs 310093/310170 were verified gone; no llama-server
or Agent sidecar remained and port 18081 was closed. GPU returned to
933 MiB used / 23,186 MiB free. No original user application/runtime was
running before these tests, so none needed restarting. The unrelated user
Ollama daemon/data were not touched. No sudo or `--no-sandbox` was used.
