import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../dist/memory/store.js";
import { AuditLogger } from "../dist/audit/logger.js";
import { defaultImportance } from "../dist/memory/importance.js";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safeflow-life-"));
}

test("importance: type and keyword boosts apply within [0,1]", () => {
  assert.ok(
    defaultImportance("short note", "procedural") >
      defaultImportance("short note", "episodic"),
  );
  assert.ok(
    defaultImportance("we decided to use SQLite", "episodic") >
      defaultImportance("just a plain note here", "episodic"),
  );
  const v = defaultImportance("x", "semantic");
  assert.ok(v >= 0 && v <= 1);
});

test("store: persists lifecycle fields with defaults", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  await m.store("ns", "k", "decided: use Postgres for analytics");

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(root, ".safeflow", "memory.db"));
  const row = db
    .prepare(
      "SELECT memory_type, importance, access_count FROM memory WHERE key='k'",
    )
    .get();
  assert.equal(row.memory_type, "episodic");
  assert.ok(row.importance > 0.5, "keyword boosted importance");
  assert.equal(row.access_count, 0);
  db.close();
  m.close();
});

test("store: explicit memory_type and importance are honored", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  await m.store("ns", "k", "a procedure", {}, {
    memoryType: "procedural",
    importance: 0.9,
  });

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(root, ".safeflow", "memory.db"));
  const row = db
    .prepare("SELECT memory_type, importance FROM memory WHERE key='k'")
    .get();
  assert.equal(row.memory_type, "procedural");
  assert.ok(Math.abs(row.importance - 0.9) < 1e-9);
  db.close();
  m.close();
});

test("supersede: old record excluded from recall, new included", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  await m.store("ns", "db-choice", "we will use MySQL for the project");

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(root, ".safeflow", "memory.db"));
  const oldId = db
    .prepare("SELECT rowid AS id FROM memory WHERE key='db-choice'")
    .get().id;
  db.close();

  const newId = await m.supersede(
    oldId,
    "we switched to PostgreSQL for the project",
    "decision changed",
  );
  assert.ok(typeof newId === "number" && newId !== oldId);

  const def = await m.recall({ namespace: "ns", query: "project", limit: 10 });
  const keys = def.map((r) => r.key);
  assert.ok(!keys.includes("db-choice"), "superseded old excluded");

  const all = await m.recall({
    namespace: "ns",
    query: "project",
    limit: 10,
    includeSuperseded: true,
  });
  assert.ok(all.length >= 2, "both visible with includeSuperseded");
  m.close();
});

test("supersede: throws on missing id", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  await assert.rejects(() => m.supersede(99999, "x", "y"));
  m.close();
});
