import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { migrate, MIGRATIONS } from "../dist/storage/migrations.js";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safeflow-mig-"));
}

/**
 * Создаёт реалистичную v1-БД: таблица memory + FTS, как в исходной схеме,
 * без таблицы schema_version.
 */
function makeV1Db(dbDir) {
  const dbPath = path.join(dbDir, "memory.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memory (
      namespace TEXT NOT NULL,
      key       TEXT NOT NULL,
      content   TEXT NOT NULL,
      metadata  TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      namespace UNINDEXED, key UNINDEXED, content,
      content='memory', content_rowid='rowid'
    );
  `);
  return { db, dbPath };
}

test("migrations: legacy v1 DB is marked and upgraded through latest", () => {
  const dir = mkTmp();
  const { db, dbPath } = makeV1Db(dir);
  // Старые данные присутствуют.
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO memory (namespace,key,content,created_at,updated_at) VALUES (?,?,?,?,?)",
  ).run("ns", "k", "legacy content about databases", now, now);

  migrate(db, dbPath);

  const versions = db
    .prepare("SELECT version FROM schema_version ORDER BY version")
    .all()
    .map((r) => r.version);
  const expected = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, expected, "all migration versions recorded");

  // Старые данные не потеряны.
  const row = db.prepare("SELECT content FROM memory WHERE key='k'").get();
  assert.equal(row.content, "legacy content about databases");
  db.close();
});

test("migrations: lifecycle columns and vec table exist after migrate", () => {
  const dir = mkTmp();
  const { db, dbPath } = makeV1Db(dir);
  migrate(db, dbPath);

  const cols = db
    .prepare("PRAGMA table_info(memory)")
    .all()
    .map((c) => c.name);
  for (const expected of [
    "memory_type",
    "importance",
    "last_accessed_at",
    "access_count",
    "superseded_by",
    "superseded_at",
    "source",
    "consolidated_from",
  ]) {
    assert.ok(cols.includes(expected), `column ${expected} present`);
  }

  const vecTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vec'",
    )
    .get();
  assert.ok(vecTable, "memory_vec virtual table created");
  db.close();
});

test("migrations: backup file created before schema change", () => {
  const dir = mkTmp();
  const { db, dbPath } = makeV1Db(dir);
  migrate(db, dbPath);

  const backupDir = path.join(dir, "backups");
  assert.ok(fs.existsSync(backupDir), "backups dir exists");
  const backups = fs.readdirSync(backupDir).filter((f) => f.endsWith(".bak"));
  assert.ok(backups.length >= 1, "at least one .bak backup created");
  db.close();
});

test("migrations: rerunning migrate is idempotent (no new versions)", () => {
  const dir = mkTmp();
  const { db, dbPath } = makeV1Db(dir);
  migrate(db, dbPath);
  const before = db.prepare("SELECT COUNT(*) c FROM schema_version").get().c;

  migrate(db, dbPath); // повторный запуск — должен быть no-op
  const after = db.prepare("SELECT COUNT(*) c FROM schema_version").get().c;

  assert.equal(before, after, "no duplicate migrations applied");
  db.close();
});

test("migrations: fresh DB applies all migrations through latest", () => {
  const dir = mkTmp();
  const { db, dbPath } = makeV1Db(dir);
  migrate(db, dbPath);
  const max = db.prepare("SELECT MAX(version) v FROM schema_version").get().v;
  assert.equal(max, MIGRATIONS[MIGRATIONS.length - 1].version);
  db.close();
});
