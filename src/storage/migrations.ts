/**
 * Schema versioning и migration framework.
 *
 * Принципы (см. CLAUDE.md):
 *   - Idempotent: повторный запуск migrate() безопасен.
 *   - Автобэкап перед любым изменением схемы (в `.safeflow/backups/`).
 *   - Каждая миграция применяется в транзакции; падение откатывает всё.
 *
 * Совместимость со схемой v1:
 *   Таблица `memory` имеет составной первичный ключ (namespace, key) и НЕ имеет
 *   отдельной колонки `id` — используется неявный SQLite `rowid`. Поэтому
 *   векторное хранилище и lifecycle-логика везде ссылаются на `rowid`.
 */

import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as sqliteVec from "sqlite-vec";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/**
 * Гарантирует, что расширение sqlite-vec загружено в соединение.
 * Повторная загрузка безопасна — ошибки «уже загружено» игнорируются.
 */
export function ensureVecLoaded(db: Database.Database): void {
  try {
    sqliteVec.load(db);
  } catch {
    // Расширение уже загружено в это соединение — это нормально.
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_baseline",
    up: () => {
      // no-op: маркирует существующую v1-схему (memory + memory_fts).
    },
  },
  {
    version: 2,
    name: "add_memory_vec_table",
    up: (db) => {
      ensureVecLoaded(db);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
          memory_id INTEGER PRIMARY KEY,
          embedding FLOAT[384]
        )
      `);
      // memory не имеет колонки id — ключом служит rowid.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_vec_cleanup
        AFTER DELETE ON memory
        BEGIN
          DELETE FROM memory_vec WHERE memory_id = old.rowid;
        END
      `);
    },
  },
  {
    version: 3,
    name: "add_memory_lifecycle_fields",
    up: (db) => {
      // created_at уже существует в v1-схеме как TEXT (ISO) — не пересоздаём.
      // Добавляем только отсутствующие lifecycle-колонки.
      db.exec(
        `ALTER TABLE memory ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'episodic'`,
      );
      db.exec(
        `ALTER TABLE memory ADD COLUMN importance REAL NOT NULL DEFAULT 0.5`,
      );
      db.exec(`ALTER TABLE memory ADD COLUMN last_accessed_at INTEGER`);
      db.exec(
        `ALTER TABLE memory ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`,
      );
      // superseded_by хранит rowid заместившей записи. FOREIGN KEY не ставим:
      // SQLite не допускает ссылку на неявный rowid (нет объявленного PK/UNIQUE
      // столбца — первичный ключ memory составной). Связь обеспечивается
      // транзакционно в supersede().
      db.exec(`ALTER TABLE memory ADD COLUMN superseded_by INTEGER`);
      db.exec(`ALTER TABLE memory ADD COLUMN superseded_at INTEGER`);
      db.exec(`ALTER TABLE memory ADD COLUMN source TEXT`);
      db.exec(`ALTER TABLE memory ADD COLUMN consolidated_from TEXT`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_ns_type
          ON memory(namespace, memory_type) WHERE superseded_by IS NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_importance
          ON memory(namespace, importance DESC) WHERE superseded_by IS NULL
      `);
    },
  },
];

export function migrate(db: Database.Database, dbPath: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const memoryTableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory'",
    )
    .get();

  const currentVersion =
    (
      db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
        v: number | null;
      }
    ).v ?? 0;

  // Унаследованные БД v1 (таблица memory уже есть, версий нет) — маркируем v1.
  if (memoryTableExists && currentVersion === 0) {
    db.prepare("INSERT INTO schema_version VALUES (?, ?, ?)").run(
      1,
      "initial_baseline",
      Date.now(),
    );
  }

  const applied =
    (
      db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
        v: number | null;
      }
    ).v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > applied);
  if (pending.length === 0) return;

  // Автобэкап перед изменениями схемы.
  if (fs.existsSync(dbPath)) {
    const backupDir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(
      backupDir,
      `memory.db.pre-v${applied + 1}-${Date.now()}.bak`,
    );
    fs.copyFileSync(dbPath, backupPath);
    console.error(`[migrate] backup: ${backupPath}`);
  }

  const tx = db.transaction(() => {
    for (const m of pending) {
      console.error(`[migrate] applying v${m.version}: ${m.name}`);
      m.up(db);
      db.prepare("INSERT INTO schema_version VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Date.now(),
      );
    }
  });
  tx();
}
