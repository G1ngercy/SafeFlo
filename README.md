# SafeFlo

[![CI](https://github.com/G1ngercy/SafeFlo/actions/workflows/ci.yml/badge.svg)](https://github.com/G1ngercy/SafeFlo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![No install scripts](https://img.shields.io/badge/install_scripts-none-blue.svg)](SECURITY.md)

A local and transparent AI agent orchestration platform for Claude Code.
MCP server with tools for persistent memory, task planning, and logical agent coordination — no network calls, no hidden install scripts, no modification of files outside the project.

> 🇷🇺 Read in Russian: [README.ru.md](README.ru.md)

## TL;DR

> Give Claude Code persistent memory, structured plans, and logical agents. All data lives in `./.safeflow/`. Uninstall with a single command. No surprises.

## Contents

- [What's inside](#whats-inside)
- [Installation](#installation)
- [Using from Claude Code](#using-from-claude-code)
- [Programmatic API](#programmatic-api)
- [Uninstall](#uninstall)
- [Security](#security)
- [Comparison with similar projects](#comparison-with-similar-projects)
- [Contributing](#contributing)
- [License](#license)

## What's inside

| Module | Description |
|---|---|
| **Memory store** | SQLite + FTS5 (full-text search) for key-value memory with namespace isolation. Parameterized SQL queries. |
| **Task planner** | Structured goal decomposition into steps with dependencies and verified status transitions. |
| **Agent coordinator** | Registration of logical agents with an isolated memory namespace each. No background processes. |
| **MCP server** | 15 clean tools with transparent descriptions. |
| **Audit log** | Append-only JSONL of all operations. |
| **CLI** | `init`, `status`, `mcp`, `uninstall` (with real, complete cleanup). |

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
- `./.safeflow/` — local databases and audit log
- `./.claude/commands/safeflow-*.md` — slash commands for Claude Code

To register the MCP server with Claude Code:

```bash
claude mcp add safeflow -- node /path/to/safeflow/dist/mcp/server.js
```

## Using from Claude Code

Once connected, Claude Code gains these tools:

**Memory:**
- `memory_store(namespace, key, content, metadata?)`
- `memory_get(namespace, key)`
- `memory_search(namespace, query, limit?)`
- `memory_list(namespace, limit?)`
- `memory_delete(namespace, key)`

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

memory.store("project.notes", "decision-1", "Use SQLite for memory");

const plan = planner.createPlan("Add authentication");
const step = planner.addStep(plan.id, {
  title: "Design schema",
  description: "users, sessions",
  dependsOn: [],
});

const agent = coord.register("researcher", "Survey auth libraries");
```

## Uninstall

```bash
node /path/to/safeflow/dist/cli.js uninstall --yes
```

This removes:
- `./.safeflow/` — all local databases and audit log
- `./.claude/commands/safeflow-*.md`

SafeFlo uses no global paths whatsoever, so there is nothing to clean up outside the project. **Genuinely nothing.** Verify for yourself: `grep -rn "homedir\|os\.home" src/` returns no results.

## Security

The full threat model and guarantees are in [SECURITY.md](SECURITY.md). Quick summary:

- **No install scripts** in `package.json` (CI checks this automatically).
- **No network calls** in the code (CI greps for this).
- **No modification of files outside the project** — all data in `./.safeflow/`.
- **Parameterized SQL** everywhere, Zod validation on every input.
- **Protection against path traversal** (including `....//` bypasses), prototype pollution, SQL injection.
- **Transparent MCP descriptions** — no hidden directives to the LLM. Audited automatically in CI.
- **Complete uninstall** with a single command.
- **Minimal dependencies** — 3 packages with pinned versions (`@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`).
- **Provenance** — npm packages are published with cryptographic attestation via GitHub Actions.

Vulnerabilities — through private security advisory, **not** through public issues. See [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Comparison with similar projects

SafeFlo is designed as a secure alternative to functionally similar projects. The main architectural differences:

| Aspect | Problematic projects | SafeFlo |
|---|---|---|
| Installation | `curl ... \| bash` from a CDN | `git clone` + `npm ci` with pinned versions |
| Install scripts | `preinstall`, `postinstall` | None, CI verifies |
| Data storage | `~/.claude`, `~/.npm`, background directories | Only `./.safeflow/` in the project |
| Network calls | To external services, telemetry | None, CI verifies |
| MCP descriptions | With hidden instructions | Functional only, audited |
| Uninstall | Impossible without leftovers | `safeflow uninstall --yes` |
| Open CVEs | Accumulate | Reproducible builds, Dependabot |
| "Enterprise" features | Stubs with fake numbers | Only what genuinely works |
| API surface | 87+ MCP tools, 60+ agent types | 15 MCP tools, one logical-agent concept |

**Fewer features, more transparency.** We don't implement cross-machine "federated" coordination or "enterprise security scan." We do three things (memory, plans, coordination) and do them without surprises.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short:

- For bugs — issue → fork → PR with a test.
- For features — **issue first**, then PR.
- For vulnerabilities — private security advisory, not a public issue.

Code of Conduct — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT, see [LICENSE](LICENSE).
