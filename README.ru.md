# SafeFlo

[![CI](https://github.com/G1ngercy/SafeFlo/actions/workflows/ci.yml/badge.svg)](https://github.com/G1ngercy/SafeFlo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![No install scripts](https://img.shields.io/badge/install_scripts-none-blue.svg)](SECURITY.md)

Локальный, прозрачный сервер **памяти агента** для Claude Code.
MCP-сервер с персистентной гибридной памятью (лексический + семантический поиск),
жизненным циклом памяти (типы, важность, supersession, консолидация),
планированием задач и координацией логических агентов — все данные в
`./.safeflow/`, без скрытых install-скриптов, без модификации файлов вне проекта.

> 🇬🇧 Read in English: [README.md](README.md)

## TL;DR

> Дайте Claude Code персистентную, индексируемую память, которая понимает
> парафразы, — плюс структурированные планы и логических агентов. Все данные
> живут в `./.safeflow/`. Удаление — одной командой. Никаких сюрпризов.

## Содержание

- [Что внутри](#что-внутри)
- [Установка](#установка)
- [Использование из Claude Code](#использование-из-claude-code)
- [Модель памяти](#модель-памяти)
- [Поиск](#поиск)
- [Бенчмарк](#бенчмарк)
- [Программный API](#программный-api)
- [Компромиссы и ограничения](#компромиссы-и-ограничения)
- [Удаление](#удаление)
- [Безопасность](#безопасность)
- [Вклад](#вклад)
- [Лицензия](#лицензия)

## Что внутри

| Модуль | Описание |
|---|---|
| **Memory store** | SQLite с гибридным поиском — FTS5 (лексический) + `sqlite-vec` (семантический), объединённые через Reciprocal Rank Fusion. Жизненный цикл памяти: типы, важность, supersession, консолидация. Только параметризованные SQL. |
| **Task planner** | Структурированная декомпозиция целей на шаги с зависимостями и проверяемыми переходами статусов. |
| **Agent coordinator** | Регистрация логических агентов, у каждого — изолированный memory namespace. Без фоновых процессов. |
| **MCP server** | 18 инструментов с прозрачными, только функциональными описаниями. |
| **Audit log** | Append-only JSONL всех операций. |
| **CLI** | `init`, `status`, `mcp`, `backfill-embeddings`, `uninstall` (с реальной, полной очисткой). |

## Установка

```bash
# Клонируйте репозиторий — никаких curl | bash установщиков.
git clone https://github.com/G1ngercy/SafeFlo.git
cd safeflow

# npm ci строго следует package-lock.json — никаких подмен версий.
# В package.json нет preinstall/postinstall скриптов.
npm ci

# Сборка и тесты
npm run build
npm test
```

> **Семантический поиск требует модели эмбеддингов.** При первом обращении SafeFlo
> один раз скачивает модель `paraphrase-multilingual-MiniLM-L12-v2` (~120 МБ) с
> Hugging Face в `./.safeflow/models/`. До этого (или если вы отказались от
> эмбеддингов) поиск работает в режиме FTS5. Подробности — в [SECURITY.md](SECURITY.md).

Чтобы использовать в своём проекте:

```bash
cd /path/to/your/project
node /path/to/safeflow/dist/cli.js init
```

Это создаст:
- `./.safeflow/` — локальные БД, кэш модели и audit log
- `./.claude/commands/safeflow-*.md` — slash-команды для Claude Code

Чтобы подключить MCP-сервер к Claude Code:

```bash
claude mcp add safeflow -- node /path/to/safeflow/dist/mcp/server.js
```

## Использование из Claude Code

После подключения у Claude Code появятся инструменты:

**Memory:**
- `memory_store(namespace, key, content, metadata?, memory_type?, importance?, source?)`
- `memory_get(namespace, key)`
- `memory_recall(namespace, query, limit?, memory_types?, include_superseded?)` — гибридный поиск (рекомендуется)
- `memory_search(namespace, query, limit?)` — **[устарел, используйте `memory_recall`]** только FTS5
- `memory_list(namespace, limit?)`
- `memory_delete(namespace, key)`
- `memory_supersede(old_id, new_content, reason)` — заменить устаревший факт
- `memory_consolidate(namespace, dry_run?)` — найти эпизодические кластеры для обобщения

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

## Модель памяти

**Эпизодическая / семантическая / процедурная.** У каждой записи есть `memory_type`.
*Эпизодическая* — по умолчанию: конкретное наблюдение или событие («сегодня мы решили
X»). *Семантическая* — обобщённое, устойчивое знание, дистиллированное из эпизодов.
*Процедурная* фиксирует, как что-то делается, — шаги, соглашения, runbook'и. Тип влияет
на ранжирование и является единицей, которую продвигает консолидация (эпизодическое →
семантическое).

**Важность.** Каждая запись несёт `importance` в диапазоне `[0, 1]`, который усиливает
ранжирование при recall. По умолчанию — прозрачная эвристика, выведенная из содержимого
(тип, ключевые слова решений на RU/EN, длина); можно задать явно. Никакого машинного
обучения, никаких скрытых сигналов.

**Supersession.** Факты устаревают. `memory_supersede(old_id, new_content, reason)`
записывает замену как новую запись и помечает старую как `superseded_by` новой. Старая
запись **сохраняется** для истории и аудита, но по умолчанию исключается из recall
(передайте `include_superseded`, чтобы её увидеть).

**Консолидация.** `memory_consolidate` находит кластеры похожих, более старых
эпизодических записей (жадная агломерация по их векторам с косинусной близостью) и
возвращает их вместе с примерами содержимого. Сервер **не** выполняет суммаризацию и
**не** делает сетевых вызовов — клиент сам решает, что обобщить, и сохраняет результат
как `semantic`-запись. Так сохраняется граница «никакой сети в runtime».

## Поиск

Гибридный: **FTS5** для лексического совпадения + **`sqlite-vec`** для семантической
близости, объединённые через **Reciprocal Rank Fusion (RRF)**, затем скорректированные
важностью и бустом свежести. Если модель эмбеддингов отсутствует (или вы от неё
отказались), recall плавно деградирует до режима FTS5 — ничего не ломается, вы просто
теряете семантическую составляющую.

## Бенчмарк

`npm run bench` сравнивает легаси FTS-only `search()` с гибридным v2 `recall()` на
смешанном RU/EN датасете (6 кейсов, 24 записи, 22 запроса). Результаты с
`paraphrase-multilingual-MiniLM-L12-v2`:

| Тип запроса | v1 recall@5 | v2 recall@5 | Δ |
|---|---|---|---|
| лексический | 100.0% | 100.0% | +0.0 п.п. |
| синоним | 44.4% | 100.0% | **+55.6 п.п.** |
| концепт | 57.1% | 100.0% | **+42.9 п.п.** |

MRR на синонимичных запросах растёт с 0.333 до 0.861. Как и ожидалось, лексические
запросы не меняются (FTS уже идеально берёт точные слова); выигрыш — на парафразах и
концептуальных запросах, ровно там, где key-value/FTS-хранилище проигрывает для
AI-агента. Сырые результаты — в [`benchmark-results/`](benchmark-results/).

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

await memory.store("project.notes", "decision-1", "Use SQLite for memory", {}, {
  memoryType: "semantic",
});

const hits = await memory.recall({
  namespace: "project.notes",
  query: "какую базу данных мы выбрали",
});

const plan = planner.createPlan("Add authentication");
const step = planner.addStep(plan.id, {
  title: "Design schema",
  description: "users, sessions",
  dependsOn: [],
});

const agent = coord.register("researcher", "Survey auth libraries");
```

## Компромиссы и ограничения

- **Первая загрузка модели требует сети.** Семантический поиск опирается на модель
  `paraphrase-multilingual-MiniLM-L12-v2` (~120 МБ), которая один раз скачивается с
  Hugging Face в `./.safeflow/models/`. До этого поиск работает только через FTS5. От
  эмбеддингов можно отказаться полностью и остаться на FTS5. См. [SECURITY.md](SECURITY.md).
- **Нативные модули.** `better-sqlite3` и `sqlite-vec` — нативные; им нужны
  предсобранные бинарники или тулчейн под вашу платформу.
- **Масштаб.** Это локальный, однофайловый SQLite-дизайн. После ~100k записей вам нужна
  выделенная векторная база и другая архитектура; SafeFlo рассчитан на рабочую память
  проекта, а не на data lake.

## Удаление

```bash
node /path/to/safeflow/dist/cli.js uninstall --yes
```

Удалит:
- `./.safeflow/` — все локальные БД, кэш модели и audit log
- `./.claude/commands/safeflow-*.md`

SafeFlo не использует никаких глобальных путей, поэтому за пределами проекта удалять
нечего. **Реально нечего.** Проверьте сами: `grep -rn "homedir\|os\.home" src/` ничего
не вернёт.

## Безопасность

Полная модель угроз и гарантии — в [SECURITY.md](SECURITY.md). Краткое резюме:

- **Нет install-скриптов** в `package.json` (CI проверяет это автоматически).
- **Нет сетевых вызовов при операциях с памятью.** Единственное исключение: модель
  эмбеддингов (~120 МБ) скачивается при первом использовании; откажитесь от неё, чтобы
  остаться на FTS5. Документировано в [SECURITY.md](SECURITY.md#network-calls).
- **Нет модификации файлов вне проекта** — все данные в `./.safeflow/`.
- **Параметризованные SQL** везде, валидация Zod на каждом входе.
- **Защита от path traversal** (включая `....//` обходы), prototype pollution, SQL injection.
- **Прозрачные MCP descriptions** — без скрытых директив для LLM. Автоматически аудитируются в CI.
- **Идемпотентные миграции с автоматическими бэкапами** в `./.safeflow/backups/` перед любым изменением схемы.
- **Полное удаление** одной командой.
- **Pinned-зависимости** — 5 пакетов с точными версиями (`@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `@xenova/transformers`, `zod`).
- **Дистрибуция через `git clone`** — без npm registry, без `curl | bash` установщика. Сборка идёт из зафиксированного `package-lock.json`; релизы — теговые коммиты с GitHub Release notes (см. [docs/RELEASE.md](docs/RELEASE.md)).

Уязвимости — через приватный security advisory, **не** через публичный issue. См. [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Вклад

См. [CONTRIBUTING.md](CONTRIBUTING.md). Кратко:

- Для багов — issue → fork → PR с тестом.
- Для фич — **сначала issue**, потом PR.
- Для уязвимостей — приватный security advisory, не публичный issue.

Code of Conduct — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Лицензия

MIT, см. [LICENSE](LICENSE).
