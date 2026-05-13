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

export class MemoryStore {
  private readonly db: Database.Database;
  private readonly audit: AuditLogger;

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
    this.initSchema();
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
   * Сохраняет значение. Если ключ существует — обновляет.
   * Все аргументы валидируются Zod-ом.
   */
  store(
    namespace: string,
    key: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): MemoryRecord {
    const ns = MemoryNamespace.parse(namespace);
    const k = MemoryKey.parse(key);
    const c = ContentString.parse(content);
    assertSafeObject(metadata);

    const now = new Date().toISOString();
    const metaJson = JSON.stringify(metadata);

    // Параметризованный upsert. ИМЕНОВАННЫЕ параметры — никакой конкатенации.
    const stmt = this.db.prepare(`
      INSERT INTO memory (namespace, key, content, metadata, created_at, updated_at)
      VALUES (@ns, @key, @content, @meta, @now, @now)
      ON CONFLICT(namespace, key) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);
    stmt.run({ ns, key: k, content: c, meta: metaJson, now });

    this.audit.log({
      source: "memory",
      action: "store",
      payload: { namespace: ns, key: k, contentLength: c.length },
      outcome: "ok",
    });

    return {
      namespace: ns,
      key: k,
      content: c,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
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
   * Полнотекстовый поиск через FTS5. Используем bm25 — встроенный ранкер.
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
