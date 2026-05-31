/**
 * Бенчмарк-датасет: реалистичные записи памяти разработки (RU + EN) и запросы
 * трёх типов:
 *   - lexical — точные слова из записи присутствуют в запросе;
 *   - synonym — та же мысль другими словами;
 *   - concept — общая тема без конкретных слов записи.
 *
 * Цель: показать, что гибридный recall() выигрывает у FTS-only search() на
 * synonym/concept и не проигрывает на lexical.
 */

export type QueryType = "lexical" | "synonym" | "concept";

export interface BenchmarkCase {
  description: string;
  storedRecords: { key: string; content: string }[];
  queries: {
    query: string;
    type: QueryType;
    expectedKeys: string[];
  }[];
}

export const DATASET: BenchmarkCase[] = [
  {
    description: "Database choice (EN)",
    storedRecords: [
      {
        key: "db-engine",
        content:
          "We decided to use SQLite as the embedded database, no separate server needed.",
      },
      {
        key: "db-postgres",
        content:
          "Postgres was considered but rejected due to operational overhead.",
      },
      {
        key: "db-location",
        content:
          "All application data lives locally in the project directory under .safeflow.",
      },
      {
        key: "db-pooling",
        content: "Connection pooling is irrelevant for an embedded engine.",
      },
    ],
    queries: [
      { query: "SQLite embedded database", type: "lexical", expectedKeys: ["db-engine"] },
      { query: "which DBMS did the team pick", type: "synonym", expectedKeys: ["db-engine"] },
      { query: "where is application data persisted", type: "concept", expectedKeys: ["db-location"] },
    ],
  },
  {
    description: "Authentication (EN)",
    storedRecords: [
      { key: "auth-jwt", content: "Authentication uses short-lived JWT access tokens." },
      { key: "auth-refresh", content: "Refresh tokens are stored in an httpOnly cookie." },
      { key: "auth-hash", content: "User passwords are hashed with argon2id before storage." },
      { key: "auth-rate", content: "Rate limiting protects the login endpoint from abuse." },
    ],
    queries: [
      { query: "JWT access tokens", type: "lexical", expectedKeys: ["auth-jwt"] },
      { query: "how do users sign in to the system", type: "synonym", expectedKeys: ["auth-jwt"] },
      { query: "protection against brute force on login", type: "concept", expectedKeys: ["auth-rate"] },
      { query: "how are credentials secured at rest", type: "synonym", expectedKeys: ["auth-hash"] },
    ],
  },
  {
    description: "Деплой (RU)",
    storedRecords: [
      { key: "dep-ci", content: "Деплой выполняется через GitHub Actions на каждый push в main." },
      { key: "dep-rollback", content: "Откат на предыдущую версию делается одной кнопкой в дашборде." },
      { key: "dep-secrets", content: "Секреты хранятся в переменных окружения, не в репозитории." },
      { key: "dep-proddb", content: "Прод-база данных не входит в этот репозиторий." },
    ],
    queries: [
      { query: "деплой GitHub Actions", type: "lexical", expectedKeys: ["dep-ci"] },
      { query: "как выкатывается новая версия приложения", type: "synonym", expectedKeys: ["dep-ci"] },
      { query: "что делать если релиз сломался в продакшене", type: "concept", expectedKeys: ["dep-rollback"] },
      { query: "где лежат ключи и пароли", type: "synonym", expectedKeys: ["dep-secrets"] },
    ],
  },
  {
    description: "Архитектура памяти (RU)",
    storedRecords: [
      { key: "mem-store", content: "Память агента хранится в локальном SQLite с FTS5 и векторным индексом." },
      { key: "mem-hybrid", content: "Поиск гибридный: лексический плюс семантический, объединённые через RRF." },
      { key: "mem-supersede", content: "Устаревшие факты помечаются superseded, а не удаляются физически." },
      { key: "mem-consolidate", content: "Эпизоды со временем консолидируются в обобщённые знания." },
    ],
    queries: [
      { query: "гибридный поиск RRF", type: "lexical", expectedKeys: ["mem-hybrid"] },
      { query: "как система находит релевантные записи", type: "synonym", expectedKeys: ["mem-hybrid"] },
      { query: "что происходит с неактуальной информацией", type: "concept", expectedKeys: ["mem-supersede"] },
      { query: "как накопленный опыт превращается в знания", type: "concept", expectedKeys: ["mem-consolidate"] },
    ],
  },
  {
    description: "Testing (EN)",
    storedRecords: [
      { key: "test-runner", content: "Unit tests run with node --test against the compiled dist output." },
      { key: "test-coverage", content: "Coverage target is eighty percent across the codebase." },
      { key: "test-bench", content: "The benchmark compares old and new search recall side by side." },
      { key: "test-flaky", content: "Flaky tests are quarantined, not deleted." },
    ],
    queries: [
      { query: "node --test unit tests", type: "lexical", expectedKeys: ["test-runner"] },
      { query: "minimum code coverage threshold", type: "synonym", expectedKeys: ["test-coverage"] },
      { query: "how do we measure search quality improvement", type: "concept", expectedKeys: ["test-bench"] },
    ],
  },
  {
    description: "Security (mixed RU/EN)",
    storedRecords: [
      { key: "sec-sql", content: "SQL-запросы только параметризованные, без конкатенации строк." },
      { key: "sec-audit", content: "Каждая операция записи логируется в append-only audit log." },
      { key: "sec-network", content: "The server makes no network calls except the one-time embedding model download." },
      { key: "sec-proto", content: "Prototype pollution keys like __proto__ are rejected on input." },
    ],
    queries: [
      { query: "параметризованные SQL запросы", type: "lexical", expectedKeys: ["sec-sql"] },
      { query: "how is every change recorded for traceability", type: "synonym", expectedKeys: ["sec-audit"] },
      { query: "защита от инъекций в базу данных", type: "concept", expectedKeys: ["sec-sql"] },
      { query: "does the server phone home", type: "synonym", expectedKeys: ["sec-network"] },
    ],
  },
];
