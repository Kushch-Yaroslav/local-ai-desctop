# Llama-only / GPT-OSS validation status

This is a work-in-progress validation record for branch
`feat/llama-only-gpt-oss`. It is not a release approval. The branch must not be
merged into `v2-migration` or pushed until the GPT-OSS Agent+Deep reliability
gate and the remaining regressions pass.

## Preserved base

- The starting V2 preservation point is merge commit
  `5df8e6a0042d442c661879b3461f4f8dd46e376f`, with the validated Deep/Fast
  branch merged without squashing.
- `v2-migration` remains at that commit. Feature work is local only and has not
  been merged or pushed.

## GPT-OSS runtime and model

- Model: official `ggml-org/gpt-oss-20b-GGUF`, MXFP4 GGUF.
- Local file: `/media/yaroslav/DATA/llama-models/gpt-oss-20b-MXFP4.gguf`
  (12,109,566,624 bytes; SHA-256
  `27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901`).
- Tested runtime: llama.cpp `0.4.1-dev`, commit `d1d3c33`; the GGUF advertises
  131,072 trained context tokens. Its native template/reasoning support was
  confirmed.
- The task-owned live server used port `18081`, context `32768`, GPU layers
  `999`, flash attention, F16 K/V cache, parallelism `1`, no speculative
  decoding, Jinja templates, and automatic reasoning format. It was stopped
  after each run; the port was verified closed.
- Direct Chat, streaming, structured tool call, and tool-result roundtrip
  completed. These checks do not establish Agent reliability.

## Agent+Deep gate: blocked

The first durable-evidence 32K run completed with one final response after 45
turns and 44 tool calls. It had 8 rejected duplicate reads, no Task Memory
updates, and cited impossible line ranges for `register-ipc.ts` (up to line
54,642 although the file had 664 lines at test time).

Trace inspection found no demonstrated model-specific wire-protocol
incompatibility. The generic Deep checkpoint and Task Memory tool were in the
provider request. Duplicate-read errors came from the existing unchanged-read
guard; GPT-OSS repeated those reads instead of using the recovery observation.
The run also uncovered a generic evidence bug: chunked reads carried character
offsets but durable evidence labeled the chunks as whole-file line ranges.

That generic bug is fixed on this branch. Chunked reads now expose actual source
line ranges and partial-line boundaries; evidence metadata preserves those
ranges and does not label an empty chunk as the entire file. Out-of-range line
requests return an explicit error. Regression tests cover later chunks and
end-of-file handling.

A fresh 32K Agent+Deep run after the fix completed in 17 turns with 16 tool
calls, one Task Memory update, zero duplicate-read errors, one complete final,
and no compaction. Offset-as-line citations disappeared. However, the final
still attributed claims to unrelated source locations and observation IDs. For
example, it said `register-ipc.ts` lines 520–524 showed an
`activeGenerations.size` guard, while those lines handle attachment imports and
cancellation; cited observation `obs-00000010` covered lines 425–512, not that
claim. The Task Memory write had an empty evidence field and overstated its
conclusion. Therefore the Agent+Deep reliability gate remains **failed**.

No generic mechanism that would make model citations or Task Memory semantically
reliable has been established. The implementation does not force tool use,
rewrite model claims, or add a model-specific workaround. GPT-OSS is therefore
listed as experimental and is not approved as a reliable Agent+Deep model.

## Changes and remaining validation

The feature work removes Ollama application-backend wiring and adds a
llama.cpp GPT-OSS profile while retaining the Qwen MTP and GLM profiles. The
removal changes are present, but the final repository-wide audit for residual
Ollama detection, launch, connection, migration, and documentation paths has
not been completed. The feature work is unmerged and has not passed the
complete final validation gate. In particular, live Qwen/GLM/GPT-OSS
cross-model Agent+Deep checks,
reasoning/final separation, cancellation/cleanup across all models, and final
Max Context regression on the completed feature snapshot remain unverified.

## Automated validation run

On the final source snapshot, `cargo test --manifest-path
rust-agent/Cargo.toml --quiet` passed (114 unit tests and 16 integration
tests), `cargo fmt --manifest-path rust-agent/Cargo.toml --check` passed, and
`git diff --check` passed. The existing `npm run build` completed successfully,
including the Rust runtime build, TypeScript typecheck, Vite renderer build,
and Electron TypeScript build. `npm run test:max-context` passed, including
its build, context/VRAM discovery, llama backend, database, Electron sandbox,
and launcher-failure checks. The compiled Rust Agent bridge test
`node dist/main/services/rust-agent-runtime.test.js` also passed.

The Vite build emitted the existing warning about chunks larger than 500 kB.
These checks do not clear the live GPT-OSS Agent+Deep blocker or substitute for
the unrun cross-model and end-to-end checks above.

The repository's existing `npm run build` script is its build convention; it
does not define an installer/AppImage packaging step. A successful build would
produce the local `dist/` output and use the existing launcher, not imply a
packaged release. This validation build produced `dist/renderer/index.html`
and `dist/main/index.js`; no distributable installer was produced and no
release is approved.
