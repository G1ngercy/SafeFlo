# SafeFlo

[![CI](https://github.com/G1ngercy/SafeFlo/actions/workflows/ci.yml/badge.svg)](https://github.com/G1ngercy/SafeFlo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![No install scripts](https://img.shields.io/badge/install_scripts-none-blue.svg)](SECURITY.md)

A local, transparent **agent memory** server for Claude Code.
MCP server with persistent hybrid memory (lexical + semantic search), a memory
lifecycle (types, importance, supersession, consolidation), task planning, and
logical agent coordination — all data in `./.safeflow/`, no hidden install
scripts, no modification of files outside the project.

> 🇷🇺 Read in Russian: [README.ru.md](README.ru.md)

## TL;DR

> Give Claude Code persistent, searchable memory that understands paraphrases —
> plus structured plans and logical agents. All data lives in `./.safeflow/`.
> Uninstall with a single command. No surprises.

## Contents

- [What's inside](#whats-inside)
- [Installation](#installation)
- [Using from Claude Code](#using-from-claude-code)
- [Memory model](#memory-model)
- [Search](#search)
- [Benchmark](#benchmark)
- [Programmatic API](#programmatic-api)
- [Trade-offs and limitations](#trade-offs-and-limitations)
- [Uninstall](#uninstall)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## What's inside

| Module | Description |
|---|---|
| **Memory store** | SQLite with hybrid search — FTS5 (lexical) + `sqlite-vec` (semantic) fused via Reciprocal Rank Fusion. Memory lifecycle: types, importance, supersession, consolidation. Parameterized SQL only. |
| **Task planner** | Structured goal decomposition into steps with dependencies and verified status transitions. |
| **Agent coordinator** | Registration of logical agents with an isolated memory namespace each. No background processes. |
| **MCP server** | 18 tools with transparent, functional-only descriptions. |
| **Audit log** | Append-only JSONL of all operations. |
| **CLI** | `init`, `status`, `mcp`, `backfill-embeddings`, `uninstall` (with real, complete cleanup). |

## Installation

```bash
# Clone the repository — no curl | bash installers.
git clone https://github.com/G1ngercy/SafeFlo.git
cd safeflow

# npm ci strictly follows package-lock.json — no version substitution.
# package.json contains no preinstall/postinstall scripts.
npm ci

# Build and test
npm run build
npm test
```

To use in your project:

```bash
cd /path/to/your/project
node /path/to/safeflow/dist/cli.js init
```

This creates:
- `./.safeflow/` — local databases, model cache, and audit log
- `./.claude/commands/safeflow-*.md` — slash commands for Claude Code

To register the MCP server with Claude Code:

```bash
claude mcp add safeflow -- node /path/to/safeflow/dist/mcp/server.js
```

## Using from Claude Code

Once connected, Claude Code gains these tools:

**Memory:**
- `memory_store(namespace, key, content, metadata?, memory_type?, importance?, source?)`
- `memory_get(namespace, key)`
- `memory_recall(namespace, query, limit?, memory_types?, include_superseded?)` — hybrid search (recommended)
- `memory_search(namespace, query, limit?)` — **[deprecated, use `memory_recall`]** FTS5-only
- `memory_list(namespace, limit?)`
- `memory_delete(namespace, key)`
- `memory_supersede(old_id, new_content, reason)` — replace an outdated fact
- `memory_consolidate(namespace, dry_run?)` — find episodic clusters to summarize

**Planning:**
- `plan_create(goal)`
- `plan_add_step(planId, title, description, dependsOn?)`
- `plan_update_step_status(stepId, status)`
- `plan_get(planId)`
- `plan_ready_steps(planId)` — steps that are ready to start
- `plan_list(limit?)`

**Agents:**
- `agent_register(role, task?)`
- `agent_list(status?)`
- `agent_update_status(agentId, status)`

**Audit:**
- `audit_tail(n?)` — last N events from the audit log

And slash commands: `/safeflow-plan`, `/safeflow-memory`, `/safeflow-agents`.

## Memory model

**Episodic / semantic / procedural.** Every record has a `memory_type`. *Episodic*
is the default: a specific observation or event ("we decided X today"). *Semantic*
is generalized, durable knowledge distilled from episodes. *Procedural* captures
how to do something — steps, conventions, runbooks. The type nudges ranking and is
the unit consolidation promotes (episodic → semantic).

**Importance.** Each record carries an `importance` in `[0, 1]` that boosts ranking
in recall. It defaults to a transparent, content-derived heuristic (type, decision
keywords in RU/EN, length) and can be set explicitly. No machine learning, no
hidden signals.

**Supersession.** Facts go stale. `memory_supersede(old_id, new_content, reason)`
writes the replacement as a new record and marks the old one `superseded_by` the
new one. The old record is **kept** for history and audit but excluded from recall
by default (pass `include_superseded` to see it).

**Consolidation.** `memory_consolidate` finds clusters of similar, older episodic
records (greedy agglomeration over their vectors by cosine similarity) and returns
them with sample contents. The server performs **no** summarization and **no**
network calls — the client decides what to summarize and stores the result as a
`semantic` record. This keeps the "no network at runtime" boundary intact.

## Search

Hybrid: **FTS5** for lexical matching + **`sqlite-vec`** for semantic similarity,
combined via **Reciprocal Rank Fusion (RRF)**, then adjusted by importance and a
recency boost. If the embedding model is not present (or you opt out), recall
degrades gracefully to FTS5-only — nothing breaks, you just lose the semantic leg.

## Benchmark

`npm run bench` compares the legacy FTS-only `search()` against the v2 hybrid
`recall()` over a mixed RU/EN dataset (6 cases, 24 records, 22 queries). Results
with `paraphrase-multilingual-MiniLM-L12-v2`:

| Query type | v1 recall@5 | v2 recall@5 | Δ |
|---|---|---|---|
| lexical | 100.0% | 100.0% | +0.0 п.п. |
| synonym | 44.4% | 100.0% | **+55.6 п.п.** |
| concept | 57.1% | 100.0% | **+42.9 п.п.** |

MRR on synonym queries rises from 0.333 to 0.861. As expected, lexical queries are
unchanged (FTS already nails exact words); the win is on paraphrased and conceptual
queries — exactly where a key-value/FTS store falls short for an AI agent. Raw
results are in [`benchmark-results/`](benchmark-results/).

## Programmatic API

```typescript
import {
  MemoryStore,
  TaskPlanner,
  AgentCoordinator,
  AuditLogger,
} from "safeflow";

const audit = new AuditLogger(process.cwd());
const memory = new MemoryStore(process.cwd(), audit);
const planner = new TaskPlanner(process.cwd(), audit);
const coord = new AgentCoordinator(process.cwd(), audit);

await memory.store("project.notes", "decision-1", "Use SQLite for memory", {}, {
  memoryType: "semantic",
});

const hits = await memory.recall({
  namespace: "project.notes",
  query: "which database did we choose",
});

const plan = planner.createPlan("Add authentication");
const step = planner.addStep(plan.id, {
  title: "Design schema",
  description: "users, sessions",
  dependsOn: [],
});

const agent = coord.register("researcher", "Survey auth libraries");
```

## Trade-offs and limitations

- **First model load requires the network.** Semantic search relies on the
  `paraphrase-multilingual-MiniLM-L12-v2` model (~120MB), downloaded once from
  Hugging Face into `./.safeflow/models/`. Until then, search is FTS5-only. You can
  opt out of embeddings entirely and stay FTS-only. See [SECURITY.md](SECURITY.md).
- **Native modules.** `better-sqlite3` and `sqlite-vec` are native; they need
  prebuilt binaries or a toolchain for your platform.
- **Scale.** This is a local, single-file SQLite design. Past ~100k records you
  want a dedicated vector database and a different architecture; SafeFlo is built
  for a project's working memory, not a data lake.

## Uninstall

```bash
node /path/to/safeflow/dist/cli.js uninstall --yes
```

This removes:
- `./.safeflow/` — all local databases, model cache, and audit log
- `./.claude/commands/safeflow-*.md`

SafeFlo uses no global paths whatsoever, so there is nothing to clean up outside the project. **Genuinely nothing.** Verify for yourself: `grep -rn "homedir\|os\.home" src/` returns no results.

## Security

The full threat model and guarantees are in [SECURITY.md](SECURITY.md). Quick summary:

- **No install scripts** in `package.json` (CI checks this automatically).
- **No network calls during memory operations.** One-time exception: the embedding
  model (~120MB) is downloaded on first use; opt out to stay FTS5-only. Documented
  in [SECURITY.md](SECURITY.md#network-calls).
- **No modification of files outside the project** — all data in `./.safeflow/`.
- **Parameterized SQL** everywhere, Zod validation on every input.
- **Protection against path traversal** (including `....//` bypasses), prototype pollution, SQL injection.
- **Transparent MCP descriptions** — no hidden directives to the LLM. Audited automatically in CI.
- **Idempotent migrations with automatic backups** to `./.safeflow/backups/` before any schema change.
- **Complete uninstall** with a single command.
- **Pinned dependencies** — 5 packages with exact versions (`@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `@xenova/transformers`, `zod`).
- **Provenance** — npm packages are published with cryptographic attestation via GitHub Actions.

Vulnerabilities — through private security advisory, **not** through public issues. See [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short:

- For bugs — issue → fork → PR with a test.
- For features — **issue first**, then PR.
- For vulnerabilities — private security advisory, not a public issue.

Code of Conduct — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT, see [LICENSE](LICENSE).
