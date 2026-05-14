# Changelog

Все значимые изменения в этом проекте документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), и проект придерживается [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/G1ngercy/SafeFlo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/G1ngercy/SafeFlo/releases/tag/v0.1.0
