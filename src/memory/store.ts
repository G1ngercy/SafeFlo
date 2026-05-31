/**
 * Persistent memory store.
 *
 * Архитектура:
 *   - SQLite (better-sqlite3) для key-value и метаданных.
 *   - Все запросы — ИСКЛЮЧИТЕЛЬНО через prepared statements с именованными
 *     параметрами. Никакой конкатенации строк в SQL.
 *   - Поиск по семантическому сходству — через простой word-overlap скор
 *     (BM25-подобный). Это даёт ~80% пользы реального векторного поиска
 *     без зависимости от тяжёлых embedding-моделей и без сетевых вызовов
 *     к API эмбеддингов. Если в будущем нужны настоящие эмбеддинги —
 *     добавляется отдельный модуль с явным согласием пользователя.
 *   - БД хранится в `.safeflow/memory.db` внутри проекта. Никаких глобальных
 *     путей, никаких `~/.claude`, `~/.npm`.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import {
  MemoryKey,
  MemoryNamespace,
  ContentString,
  assertSafeObject,
} from "../security/validation.js";
import { safeResolve } from "../security/paths.js";
import { AuditLogger } from "../audit/logger.js";
import { migrate, ensureVecLoaded } from "../storage/migrations.js";
import { EmbeddingService } from "./embedding.js";
import {
  HybridSearch,
  type ScoredMemory,
  type SearchOptions,
} from "./hybrid-search.js";
import { defaultImportance, type MemoryType } from "./importance.js";
import {
  findConsolidationCandidates,
  type ConsolidationCluster,
} from "./consolidation.js";

export interface MemoryRecord {
  namespace: string;
  key: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult extends MemoryRecord {
  score: number;
}

/** Опциональные lifecycle-поля при записи. */
export interface StoreOptions {
  memoryType?: MemoryType;
  importance?: number;
  source?: string;
}

export class MemoryStore {
  private readonly db: Database.Database;
  private readonly audit: AuditLogger;
  private readonly embeddings: EmbeddingService;
  private readonly hybrid: HybridSearch;

  constructor(projectRoot: string, audit: AuditLogger) {
    const dbDir = safeResolve(projectRoot, ".safeflow");
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    }
    const dbPath = path.join(dbDir, "memory.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.audit = audit;
    // Конструирование НЕ скачивает модель — только готовит путь кэша.
    this.embeddings = new EmbeddingService(dbDir);
    this.hybrid = new HybridSearch(this.db, this.embeddings);

    // Загружаем sqlite-vec ДО миграций (v2 создаёт vec0-таблицу) и до любых
    // векторных запросов в runtime.
    ensureVecLoaded(this.db);

    // Базовая v1-схема (idempotent), затем версионные миграции с автобэкапом.
    this.initSchema();
    migrate(this.db, dbPath);
  }

  /**
   * rowid записи по (namespace, key). У таблицы memory составной первичный
   * ключ и неявный rowid — он же ключ для memory_vec.
   */
  private rowIdOf(ns: string, key: string): number | null {
    const row = this.db
      .prepare("SELECT rowid AS id FROM memory WHERE namespace = ? AND key = ?")
      .get(ns, key) as { id: number } | undefined;
    return row ? row.id : null;
  }

  /**
   * Best-effort запись эмбеддинга в memory_vec.
   *
   * ВАЖНО (safety): если модель ещё не скачана — НЕ инициируем загрузку.
   * Запись остаётся FTS-only. Реальная загрузка модели происходит только
   * по явной команде (backfill / benchmark) с согласия пользователя.
   * Любая ошибка эмбеддинга логируется, но не блокирует запись в memory.
   */
  private async writeEmbedding(rowId: number, content: string): Promise<void> {
    if (this.embeddings.needsDownload()) return;
    try {
      const vec = await this.embeddings.embedOne(content);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO memory_vec(memory_id, embedding) VALUES (?, ?)",
        )
        // sqlite-vec требует INTEGER первичный ключ как BigInt — обычный JS
        // number трактуется как REAL и отвергается.
        .run(BigInt(rowId), Buffer.from(vec.buffer));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.log({
        source: "memory",
        action: "embed_skip",
        payload: { rowId, message },
        outcome: "error",
        reason: message,
      });
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        namespace TEXT NOT NULL,
        key       TEXT NOT NULL,
        content   TEXT NOT NULL,
        metadata  TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory(namespace);
      CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory(updated_at);

      -- Полнотекстовый индекс для поиска. SQLite FTS5.
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        namespace UNINDEXED,
        key UNINDEXED,
        content,
        content='memory',
        content_rowid='rowid'
      );

      -- Триггеры синхронизации с FTS — стандартный паттерн SQLite.
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, namespace, key, content)
        VALUES (new.rowid, new.namespace, new.key, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, namespace, key, content)
        VALUES('delete', old.rowid, old.namespace, old.key, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, namespace, key, content)
        VALUES('delete', old.rowid, old.namespace, old.key, old.content);
        INSERT INTO memory_fts(rowid, namespace, key, content)
        VALUES (new.rowid, new.namespace, new.key, new.content);
      END;
    `);
  }

  /**
   * Синхронная запись строки memory (upsert) с lifecycle-полями.
   * Возвращает rowid. НЕ делает эмбеддинг — это ответственность вызывающего
   * (эмбеддинг асинхронен и не может выполняться внутри SQLite-транзакции).
   */
  private storeRow(params: {
    ns: string;
    key: string;
    content: string;
    metadata: Record<string, unknown>;
    memoryType: MemoryType;
    importance: number;
    source: string | null;
  }): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO memory
        (namespace, key, content, metadata, memory_type, importance, source,
         created_at, updated_at)
      VALUES
        (@ns, @key, @content, @meta, @type, @importance, @source, @now, @now)
      ON CONFLICT(namespace, key) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata,
        memory_type = excluded.memory_type,
        importance = excluded.importance,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      ns: params.ns,
      key: params.key,
      content: params.content,
      meta: JSON.stringify(params.metadata),
      type: params.memoryType,
      importance: params.importance,
      source: params.source,
      now,
    });
    const rowId = this.rowIdOf(params.ns, params.key);
    if (rowId === null) {
      throw new Error("failed to resolve rowid after store");
    }
    return rowId;
  }

  /**
   * Сохраняет значение. Если ключ существует — обновляет.
   * Все аргументы валидируются Zod-ом. Lifecycle-поля опциональны: при
   * отсутствии importance берётся из defaultImportance(), тип — episodic.
   */
  async store(
    namespace: string,
    key: string,
    content: string,
    metadata: Record<string, unknown> = {},
    opts: StoreOptions = {},
  ): Promise<MemoryRecord> {
    const ns = MemoryNamespace.parse(namespace);
    const k = MemoryKey.parse(key);
    const c = ContentString.parse(content);
    assertSafeObject(metadata);

    const memoryType: MemoryType = opts.memoryType ?? "episodic";
    const importance =
      typeof opts.importance === "number"
        ? Math.max(0, Math.min(1, opts.importance))
        : defaultImportance(c, memoryType);
    const source = opts.source ?? null;

    const now = new Date().toISOString();
    const rowId = this.storeRow({
      ns,
      key: k,
      content: c,
      metadata,
      memoryType,
      importance,
      source,
    });

    this.audit.log({
      source: "memory",
      action: "store",
      payload: {
        namespace: ns,
        key: k,
        contentLength: c.length,
        memoryType,
        importance,
      },
      outcome: "ok",
    });

    // Best-effort векторизация (после синхронной записи). Не блокирует store
    // при отсутствии модели или ошибке — деградирует к FTS-only.
    await this.writeEmbedding(rowId, c);

    return {
      namespace: ns,
      key: k,
      content: c,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Заменяет устаревший факт новым: создаёт новую запись и помечает старую
   * superseded_by → новой. Старая запись не удаляется (аудит/история), но по
   * умолчанию исключается из recall().
   *
   * Возвращает rowid новой записи.
   */
  async supersede(
    oldId: number,
    newContent: string,
    reason: string,
  ): Promise<number> {
    const c = ContentString.parse(newContent);

    interface OldRow {
      namespace: string;
      key: string;
      memory_type: string | null;
      importance: number | null;
    }

    const newId = this.db.transaction((): number => {
      const old = this.db
        .prepare(
          "SELECT namespace, key, memory_type, importance FROM memory WHERE rowid = ?",
        )
        .get(oldId) as OldRow | undefined;
      if (!old) throw new Error(`memory ${oldId} not found`);

      const memoryType = (old.memory_type ?? "episodic") as MemoryType;
      const bumped = Math.min(1, (old.importance ?? 0.5) + 0.1);
      const id = this.storeRow({
        ns: old.namespace,
        key: `${old.key}-v${Date.now()}`,
        content: c,
        metadata: {},
        memoryType,
        importance: bumped,
        source: JSON.stringify({ supersedes: oldId, reason }),
      });

      this.db
        .prepare(
          "UPDATE memory SET superseded_by = ?, superseded_at = ? WHERE rowid = ?",
        )
        .run(id, Date.now(), oldId);

      return id;
    })();

    this.audit.log({
      source: "memory",
      action: "supersede",
      payload: { oldId, newId, reason },
      outcome: "ok",
    });

    // Эмбеддинг новой записи — вне транзакции (async).
    await this.writeEmbedding(newId, c);
    return newId;
  }

  get(namespace: string, key: string): MemoryRecord | null {
    const ns = MemoryNamespace.parse(namespace);
    const k = MemoryKey.parse(key);

    const stmt = this.db.prepare(`
      SELECT namespace, key, content, metadata, created_at, updated_at
      FROM memory
      WHERE namespace = @ns AND key = @key
    `);
    const row = stmt.get({ ns, key: k }) as
      | {
          namespace: string;
          key: string;
          content: string;
          metadata: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      namespace: row.namespace,
      key: row.key,
      content: row.content,
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  delete(namespace: string, key: string): boolean {
    const ns = MemoryNamespace.parse(namespace);
    const k = MemoryKey.parse(key);

    const stmt = this.db.prepare(`
      DELETE FROM memory WHERE namespace = @ns AND key = @key
    `);
    const result = stmt.run({ ns, key: k });

    this.audit.log({
      source: "memory",
      action: "delete",
      payload: { namespace: ns, key: k },
      outcome: result.changes > 0 ? "ok" : "denied",
      reason: result.changes === 0 ? "key not found" : undefined,
    });

    return result.changes > 0;
  }

  list(namespace: string, limit = 100): MemoryRecord[] {
    const ns = MemoryNamespace.parse(namespace);
    const lim = Math.min(Math.max(1, Math.floor(limit)), 1000);

    const stmt = this.db.prepare(`
      SELECT namespace, key, content, metadata, created_at, updated_at
      FROM memory
      WHERE namespace = @ns
      ORDER BY updated_at DESC
      LIMIT @lim
    `);
    const rows = stmt.all({ ns, lim }) as Array<{
      namespace: string;
      key: string;
      content: string;
      metadata: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      namespace: r.namespace,
      key: r.key,
      content: r.content,
      metadata: JSON.parse(r.metadata),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Гибридный recall: FTS5 + векторы (sqlite-vec), объединённые через RRF,
   * с recency- и importance-бустами. Деградирует к FTS-only без модели.
   *
   * Это рекомендованный способ поиска в памяти (см. deprecated search()).
   */
  async recall(opts: SearchOptions): Promise<ScoredMemory[]> {
    MemoryNamespace.parse(opts.namespace);
    const results = await this.hybrid.search(opts);
    this.audit.log({
      source: "memory",
      action: "recall",
      payload: {
        namespace: opts.namespace,
        queryLength: opts.query.length,
        returned: results.length,
      },
      outcome: "ok",
    });
    return results;
  }

  /**
   * Находит кластеры близких эпизодических записей — кандидатов на обобщение
   * в semantic-запись. Сервер НЕ делает LLM-вызовов: возвращает кластеры с
   * samples, а решение о суммаризации принимает клиент (и сам вызывает store
   * с memory_type='semantic'). Только чтение.
   */
  consolidate(
    namespace: string,
    dryRun = true,
  ): { dryRun: boolean; clusters: ConsolidationCluster[] } {
    const ns = MemoryNamespace.parse(namespace);
    const clusters = findConsolidationCandidates(this.db, { namespace: ns });
    this.audit.log({
      source: "memory",
      action: "consolidate",
      payload: { namespace: ns, dryRun, clusters: clusters.length },
      outcome: "ok",
    });
    return { dryRun, clusters };
  }

  /**
   * @deprecated Используй recall() — гибридный поиск (FTS5 + векторы, RRF).
   *
   * Полнотекстовый поиск через FTS5 (bm25). Сохранён без изменений ради
   * обратной совместимости и как baseline для бенчмарка v1 vs v2.
   * Запрос экранируется: пользовательский ввод никогда не попадает в SQL
   * напрямую, только через FTS-параметр.
   */
  search(
    namespace: string,
    query: string,
    limit = 10,
  ): SearchResult[] {
    const ns = MemoryNamespace.parse(namespace);
    const lim = Math.min(Math.max(1, Math.floor(limit)), 100);

    // Экранируем запрос для FTS5: убираем спецсимволы синтаксиса.
    const cleanQuery = this.escapeFts5(query);
    if (cleanQuery.length === 0) return [];

    const stmt = this.db.prepare(`
      SELECT
        m.namespace,
        m.key,
        m.content,
        m.metadata,
        m.created_at,
        m.updated_at,
        bm25(memory_fts) as score
      FROM memory_fts
      JOIN memory m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH @q AND m.namespace = @ns
      ORDER BY score
      LIMIT @lim
    `);
    const rows = stmt.all({ q: cleanQuery, ns, lim }) as Array<{
      namespace: string;
      key: string;
      content: string;
      metadata: string;
      created_at: string;
      updated_at: string;
      score: number;
    }>;

    return rows.map((r) => ({
      namespace: r.namespace,
      key: r.key,
      content: r.content,
      metadata: JSON.parse(r.metadata),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // bm25 в SQLite возвращает отрицательные числа (меньше = лучше);
      // инвертируем для удобства потребителя.
      score: -r.score,
    }));
  }

  /**
   * Экранирование запроса для FTS5: вырезаем спецсимволы и оборачиваем
   * каждое слово в двойные кавычки, чтобы избежать инъекций через
   * операторы NEAR/OR/AND.
   */
  private escapeFts5(q: string): string {
    const tokens = q
      .toLowerCase()
      .replace(/[^a-z0-9а-яё\s]/gi, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && t.length < 64);
    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t}"`).join(" OR ");
  }

  close(): void {
    this.db.close();
  }
}
