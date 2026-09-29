# `.ai-framework`: persistent virtual project context

`.ai-framework` is Local AI Desktop's model-neutral, project-local knowledge
cache. It lets a 32K model retain reusable semantic project knowledge on disk
without turning the canonical transcript into a growing repository dump.

The cache always lives at `<project-root>/.ai-framework/`. Its canonical entry
point is `<project-root>/.ai-framework/manifest.json`; it is never named after
a provider or model.

## Layout and manifest

V1 lazily creates only the root directory and `manifest.json`:

```text
.ai-framework/
├── manifest.json
├── project/{overview,architecture,product,conventions}.md
├── modules/
├── sources/
└── tasks/
```

The latter directories and markdown files are created only when useful. The
small, readable, versioned manifest contains project name/root fingerprint and
timestamps, the four project-knowledge paths, lazily discovered module paths,
source cache metadata (`cache`, SHA-256 fingerprint, `updatedAt`), and short
task-cache references. It deliberately does not contain all prose knowledge.
If it is missing, it is bootstrapped. If malformed, runtime preserves it as a
timestamped `manifest.corrupt-*.json` file and creates a fresh V1 index rather
than failing the Agent run.

## Hierarchy and freshness

Level 0 is the manifest index. Level 1 holds durable cross-project overview,
architecture, product and conventions documents. Level 2 holds only meaningful
modules, such as routing or purchase-flow. Level 3 holds semantic source
findings, never raw source copies. Level 4 is a concise run/task handoff that
can later be pruned.

When `project_knowledge_update` associates a source path, runtime calculates a
SHA-256 fingerprint of the current source and records it in the manifest.
`project_knowledge_index` recomputes the source fingerprint and reports
`fresh`, `stale`, `missing`, or `unknown`. A stale cache is guidance, never
truth: current source remains authoritative.

## Runtime and tools

The stable Agent prefix contains a short instruction that `.ai-framework` is
available and that the manifest should be used before repeating broad project
orientation. The current small index is projected in tail-positioned runtime
guidance, preserving the stable prompt/KV prefix. It lists availability and
paths only; knowledge bodies enter context only through bounded retrieval.

Three optional dedicated tools keep cache access inside its namespace:

- `project_knowledge_index` returns the manifest map and freshness metadata.
- `project_knowledge_read` returns bounded content for explicit cache-relative
  markdown paths.
- `project_knowledge_update` atomically writes `project/`, `modules/`,
  `sources/`, or `tasks/` markdown and refreshes source fingerprints.

`merge` is deterministic line-oriented preservation of existing and new facts;
`replace` is available when current source invalidates an older document. No
tool call is required to read source, update a plan, finish work, or answer the
user.

## Compaction boundary

Compaction does not write or curate `.ai-framework`. Runtime-owned source and
directory observations continue to update the cache deterministically, while
the model may make an explicit `project_knowledge_update` for durable facts.
The compaction request has one job: create a dense factual continuation brief
for the current task. It never asks the model to emit cache-update JSON or
requires cache persistence as a condition of a successful handoff.

This keeps a rolling transcript summary separate from persistent project
knowledge. Cached knowledge remains on disk after old source reads leave the
physical transcript, but it is recalled only through the small catalog or an
explicit read.

## Safety, traversal, and persistence

All cache paths reject absolute paths and parent traversal. Writes use a temp
file plus rename and stay beneath a canonicalized `.ai-framework` directory.
Normal Rust and Electron project directory traversal excludes `.ai-framework`,
so Agent source searches do not recursively audit their own cache. Dedicated
knowledge tools are the only intended access path.

Automatic writes redact likely token/password/secret assignment values. The
cache must never intentionally preserve raw `.env`, credentials, private keys,
or source-file copies. It does not modify `.gitignore`; users decide whether
their project cache is committed or ignored.

The cache belongs to the selected project root, so project identities never
mix. Goal/Milestone/Adaptive Work Plan persistence remains canonical elsewhere;
task cache can mention stable IDs but cannot replace plan state. A resumed run
with the same root can inspect the manifest, retrieve relevant fresh knowledge,
and read source only where needed.

## Diagnostics and limits

`knowledge_cache` diagnostics report cache existence/version, file count,
approximate bytes, stale source entries, read/write/hit counters, and bytes
projected from the small index. They contain no cache prose and are routed only
to existing telemetry/context diagnostics.

V1 permits hundreds of KB on disk. Manifest size is bounded to 64 KB,
individual writes to 32K characters, and individual tool reads to 48 KB. The
retrieval boundary, rather than disk capacity, protects model context.

## Deliberate limits and future work

V1 has no embeddings, vector database, automatic repository scan, semantic
merge model, automatic git-diff invalidation, cache browser/editor, cross-project
knowledge, workspace cache, Experience memory, subagent blackboard, or
intelligent pruning. These remain possible future extensions. Cache facts may
be incomplete or stale, so models must verify exact or changed details from
the project source.

## V1 materialization correction

A fresh cache creates only `.ai-framework/manifest.json`. Its
`projectKnowledge`, `modules`, `sources`, and `tasks` maps are empty; overview,
architecture, product, and conventions are possible runtime slots but are not
manifest entries until their markdown file is successfully written. Every
successful mutation increments a monotonic `revision`.

`project_knowledge_read` returns a structured `missing` result for an absent
logical cache path, with no OS error or alternate root spelling. Repeated
missing reads short-circuit until the revision changes. Generic fallback text
never creates a task cache.

Normal requests contain only the bounded availability catalog: known project
documents, a small module list, task paths, and fresh/stale source-observation
counts. They never automatically materialize task, overview, module, or source
document bodies. The model requests selected bodies with
`project_knowledge_read`, which supports useful path batches. This avoids
duplicating a recent raw source result, its observation, and a project overview
inside the same 32K request.

## Deterministic runtime observations

Semantic extraction is enrichment, not the only ingestion path. A successful
normal `read_file` now writes a bounded source document containing path,
fingerprint, read mode, redacted head/tail observation, and empty semantic
findings/related-areas sections. The same durable mutation updates the source
manifest entry, task document (objective, active plan labels, investigated
sources), and observed project overview. `list_directory` adds compact observed
structure to the overview. Each successful materialized mutation advances the
manifest revision before the first compaction is required.

Sensitive/internal paths (`.env`, credential/secret/private-key patterns and
`.ai-framework`) never receive raw observations. Later model-produced semantic
facts merge into these runtime-created documents rather than replacing the
observation layer.
