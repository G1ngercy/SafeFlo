import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../dist/memory/store.js";
import { AuditLogger } from "../dist/audit/logger.js";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safeflow-hybrid-"));
}

// Без скачанной модели recall() деградирует к FTS-only — эти тесты проверяют
// именно эту ветку (детерминированно, без сети).

test("recall: FTS-only returns lexical matches with fts source", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));

  await m.store("notes", "a", "we decided to use SQLite as the database");
  await m.store("notes", "b", "the meeting is scheduled for Monday");
  await m.store("notes", "c", "SQLite full text search via FTS5");

  const res = await m.recall({ namespace: "notes", query: "SQLite", limit: 10 });
  const keys = res.map((r) => r.key).sort();
  assert.deepEqual(keys, ["a", "c"]);
  for (const r of res) {
    assert.ok(r.matchedBy.includes("fts"));
    assert.ok(typeof r.score === "number" && r.score > 0);
  }
  m.close();
});

test("recall: respects namespace isolation", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));

  await m.store("ns1", "x", "alpha beta gamma");
  await m.store("ns2", "y", "alpha beta gamma");

  const res = await m.recall({ namespace: "ns1", query: "alpha", limit: 10 });
  assert.equal(res.length, 1);
  assert.equal(res[0].key, "x");
  m.close();
});

test("recall: empty query returns empty array", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  await m.store("ns", "k", "some content");

  const res = await m.recall({ namespace: "ns", query: "   ", limit: 10 });
  assert.deepEqual(res, []);
  m.close();
});

test("recall: updates access tracking on returned rows", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  await m.store("ns", "k", "trackable content about vectors");

  await m.recall({ namespace: "ns", query: "vectors", limit: 5 });
  // Повторный recall не падает и продолжает возвращать запись.
  const res = await m.recall({ namespace: "ns", query: "vectors", limit: 5 });
  assert.equal(res.length, 1);
  m.close();
});
