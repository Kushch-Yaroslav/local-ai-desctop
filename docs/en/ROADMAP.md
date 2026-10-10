# Roadmap

[English](ROADMAP.md) · [Русский](../ru/ROADMAP.md) · [Home](../../README.md)

This roadmap describes areas under consideration. It has no promised dates or delivery commitments.

## Development history: Agent V1 → Agent V2

The first Agent used Node.js. It was functional, though orchestration, maintainability, performance, and development complexity limited how far it could go. Agent V2 moved the Agent runtime to Rust, after which the project expanded its workflows, context handling and compaction, tools, and application features such as Rich Responses. Rich Responses is an application capability added later; it is not inherently tied to Rust.

## Current priorities

1. **MCP support** — explore interoperability with external tool servers and define safe permission boundaries.
2. **Long-term Experience / Memory** — investigate retained experience across separate tasks. Existing Task Notes, working memory, and context compaction support a current task; they are not this persistent memory feature.
3. **Lightweight Diff / Review UX** — a lower-priority improvement to reviewing proposed file changes.
4. **Multi-Agent Mode** — a major architectural challenge involving coordination, shared state, permissions, and resource use.

## Experimental idea

**Mobile Chat Remote** is an optional exploratory idea, not a committed core roadmap item.

Project 1/Project 2 selection and `@` Project References are already implemented. See [User guide](USER_GUIDE.md) and [Features](FEATURES.md).
