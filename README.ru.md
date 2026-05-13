# SafeFlow

[![CI](https://github.com/YOUR-ORG/safeflow/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-ORG/safeflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![No install scripts](https://img.shields.io/badge/install_scripts-none-blue.svg)](SECURITY.md)

Локальная и прозрачная платформа оркестрации AI-агентов для Claude Code.
MCP-сервер с инструментами для долговременной памяти, планирования задач и координации логических агентов — без сетевых вызовов, без скрытых install-скриптов, без модификации файлов вне проекта.

> 🇬🇧 Read in English: [README.md](README.md)

## TL;DR

> Дайте Claude Code персистентную память, структурированные планы и логических агентов. Все данные — в `./.safeflow/`. Удаление — одной командой. Никаких сюрпризов.

## Содержание

- [Что внутри](#что-внутри)
- [Установка](#установка)
- [Использование из Claude Code](#использование-из-claude-code)
- [Программный API](#программный-api)
- [Удаление](#удаление)
- [Безопасность](#безопасность)
- [Сравнение с подобными проектами](#сравнение-с-подобными-проектами)
- [Вклад](#вклад)
- [Лицензия](#лицензия)

## Что внутри

| Модуль | Описание |
|---|---|
| **Memory store** | SQLite + FTS5 (full-text search) для key-value памяти с namespace-изоляцией. Параметризованные SQL-запросы. |
| **Task planner** | Структурированная декомпозиция целей на шаги с зависимостями и проверяемыми переходами статусов. |
| **Agent coordinator** | Регистрация логических агентов с изолированным memory namespace для каждого. Без фоновых процессов. |
| **MCP server** | 15 чистых инструментов с прозрачными описаниями. |
| **Audit log** | Append-only JSONL всех операций. |
| **CLI** | `init`, `status`, `mcp`, `uninstall` (с реальной полной очисткой). |

## Установка

```bash
# Клонируйте репозиторий — никаких curl | bash установщиков.
git clone https://github.com/YOUR-ORG/safeflow.git
cd safeflow

# npm ci строго следует package-lock.json — никаких подмен версий.
# В package.json нет preinstall/postinstall скриптов.
npm ci

# Сборка и тесты
npm run build
npm test
```

Чтобы использовать в своём проекте:

```bash
cd /path/to/your/project
node /path/to/safeflow/dist/cli.js init
```

Это создаст:
- `./.safeflow/` — локальные БД и audit log
- `./.claude/commands/safeflow-*.md` — slash-команды для Claude Code

Чтобы подключить MCP-сервер к Claude Code:

```bash
claude mcp add safeflow -- node /path/to/safeflow/dist/mcp/server.js
```

## Использование из Claude Code

После подключения у Claude Code появятся инструменты:

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
- `plan_ready_steps(planId)` — шаги, готовые к выполнению
- `plan_list(limit?)`

**Agents:**
- `agent_register(role, task?)`
- `agent_list(status?)`
- `agent_update_status(agentId, status)`

**Audit:**
- `audit_tail(n?)` — последние N событий из аудит-лога

И slash-команды: `/safeflow-plan`, `/safeflow-memory`, `/safeflow-agents`.

## Программный API

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

## Удаление

```bash
node /path/to/safeflow/dist/cli.js uninstall --yes
```

Удалит:
- `./.safeflow/` — все локальные БД и аудит
- `./.claude/commands/safeflow-*.md`

SafeFlow не использует никаких глобальных путей, поэтому за пределами проекта удалять нечего. **Реально нечего.** Проверьте сами: `grep -rn "homedir\|os\.home" src/` ничего не вернёт.

## Безопасность

Полная модель угроз и гарантии — в [SECURITY.md](SECURITY.md). Краткое резюме:

- **Нет install-скриптов** в `package.json` (CI проверяет это автоматически).
- **Нет сетевых вызовов** в коде (CI проверяет grep'ом).
- **Нет модификации файлов вне проекта** — все данные в `./.safeflow/`.
- **Параметризованные SQL** везде, валидация Zod на каждом входе.
- **Защита от path traversal** (включая `....//` обходы), prototype pollution, SQL injection.
- **Прозрачные MCP descriptions** — без скрытых директив для LLM. Автоматически аудитируются в CI.
- **Полное удаление** одной командой.
- **Минимум зависимостей** — 3 пакета с pinned версиями (`@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`).
- **Provenance** — npm-пакеты публикуются с криптографической attestation через GitHub Actions.

Уязвимости — через приватный security advisory, **не** через публичный issue. См. [SECURITY.md](SECURITY.md#сообщить-об-уязвимости).

## Сравнение с подобными проектами

SafeFlow задуман как безопасная альтернатива функционально близким проектам. Главные архитектурные отличия:

| Аспект | Проблемные проекты | SafeFlow |
|---|---|---|
| Установка | `curl ... \| bash` из CDN | `git clone` + `npm ci` с pinned версиями |
| Install-скрипты | `preinstall`, `postinstall` | Их нет, CI проверяет |
| Хранение данных | `~/.claude`, `~/.npm`, фоновые директории | Только `./.safeflow/` в проекте |
| Сетевые вызовы | К внешним сервисам, telemetry | Их нет, CI проверяет |
| MCP descriptions | Со скрытыми инструкциями | Только функциональные, аудитируются |
| Удаление | Невозможно без следов | `safeflow uninstall --yes` |
| Открытые CVE | Накапливаются | Reproducible builds, dependabot |
| "Enterprise" функции | Заглушки с фейковыми числами | Только то, что реально работает |
| Поверхность API | 87+ MCP tools, 60+ типов агентов | 15 MCP tools, 1 концепция логического агента |

**Меньше фич, больше прозрачности.** Мы не реализуем многомашинную "federated" координацию или "enterprise security scan". Мы делаем три вещи (память, планы, координация) и делаем их без сюрпризов.

## Вклад

См. [CONTRIBUTING.md](CONTRIBUTING.md). Кратко:

- Для багов — issue → fork → PR с тестом.
- Для фич — **сначала issue**, потом PR.
- Для уязвимостей — приватный security advisory, не публичный issue.

Code of Conduct — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Лицензия

MIT, см. [LICENSE](LICENSE).
