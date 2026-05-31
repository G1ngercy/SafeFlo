# Changelog

Все значимые изменения в этом проекте документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), и проект придерживается [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-05-31

### Добавлено

- **Гибридный поиск** — FTS5 (лексический) + векторные эмбеддинги через `sqlite-vec` (семантический), объединённые через Reciprocal Rank Fusion, с бустами по importance и recency. Деградирует к FTS5-only без модели.
- **Lifecycle памяти** — типы записей (episodic/semantic/procedural), importance, supersession устаревших фактов, access tracking (last_accessed_at, access_count).
- **`memory_consolidate`** — поиск кластеров близких эпизодических записей для обобщения в semantic (без LLM и сети на стороне сервера).
- **`memory_supersede`** — замена устаревшего факта новым с сохранением истории.
- **`backfill-embeddings`** CLI — досчёт векторов для существующих записей.
- **Migration framework** — версионирование схемы с автоматическими бэкапами в `./.safeflow/backups/` перед любым изменением.
- **Бенчмарк** (`npm run bench`) — сравнение v1 search() vs v2 recall() по recall@5/@10/MRR.

### Изменено

- `memory_search` переименован в `memory_recall` (старое имя сохранено как deprecated-алиас, поведение FTS-only без изменений).
- `MemoryStore.store()` теперь асинхронный и принимает опциональные lifecycle-поля (`memory_type`, `importance`, `source`).
- README переписан: убрана рамка «orchestration», добавлены разделы Memory model, Search, Benchmark, Trade-offs.
- SECURITY.md: обещание «нет сетевых вызовов» уточнено — однократная opt-in загрузка модели эмбеддингов.

### Миграция

- БД v1 автоматически обновляются при первом запуске v2. Перед изменением схемы создаётся бэкап в `./.safeflow/backups/`.
- Запустите `safeflow backfill-embeddings`, чтобы посчитать векторы для существующих записей (требует однократной загрузки модели ~120MB).

### Ломающие изменения

- В runtime нет: все v1 API сохранены как deprecated-алиасы. Удаление deprecated-алиасов запланировано на v3.0.
- Для встраивания как библиотеки: `MemoryStore.store()` стал асинхронным (`await`).

## [0.1.0] - 2026-05-13

Первый публичный релиз.

### Добавлено

- **Memory store** — локальная SQLite-память с FTS5-поиском, namespace-изоляция, параметризованные SQL-запросы.
- **Task planner** — структурированная декомпозиция целей на шаги с зависимостями и валидацией переходов статусов.
- **Agent coordinator** — регистрация логических агентов с per-agent memory namespace.
- **MCP server** — 15 чистых инструментов: `memory_*`, `plan_*`, `agent_*`, `audit_tail`. Прозрачные описания без скрытых директив для LLM.
- **Audit log** — append-only JSONL в `.safeflow/audit.jsonl` для всех значимых операций.
- **CLI** с командами `init`, `status`, `mcp`, `uninstall` (последняя — с реальной полной очисткой).
- **Security utilities** — `safeResolve` (защита от path traversal), `safeFilename`, `safeJsonParse` (защита от prototype pollution), `assertSafeObject`.
- **Тесты** — 20 security-тестов плюс интеграционные тесты для memory и planner.
- **CI** — тесты на Node 20/22 × Linux/macOS/Windows, npm audit, проверка отсутствия install-скриптов, аудит MCP описаний.
- **Документация** — README, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md.

### Security

- Нет install/postinstall/preinstall скриптов в `package.json`.
- Все версии зависимостей зафиксированы (без `^` и `~`).
- Только 3 runtime-зависимости: `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`.
- Нет сетевых вызовов в коде.
- Нет модификации файлов вне директории проекта.
- Все данные хранятся в `./.safeflow/` и полностью удаляются командой `uninstall --yes`.

[Unreleased]: https://github.com/G1ngercy/SafeFlo/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/G1ngercy/SafeFlo/compare/v0.1.0...v2.0.0
[0.1.0]: https://github.com/G1ngercy/SafeFlo/releases/tag/v0.1.0
