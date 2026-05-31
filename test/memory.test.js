import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../dist/memory/store.js";
import { AuditLogger } from "../dist/audit/logger.js";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safeflow-mem-"));
}

test("memory: store/get round-trip", async () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const m = new MemoryStore(root, audit);

  await m.store("project.notes", "design", "Use SQLite, FTS5", { tag: "arch" });
  const r = m.get("project.notes", "design");
  assert.ok(r);
  assert.equal(r.content, "Use SQLite, FTS5");
  assert.deepEqual(r.metadata, { tag: "arch" });
  m.close();
});

test("memory: update overwrites", async () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const m = new MemoryStore(root, audit);

  await m.store("ns", "k", "v1");
  await m.store("ns", "k", "v2");
  assert.equal(m.get("ns", "k")?.content, "v2");
  m.close();
});

test("memory: search returns relevant", async () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const m = new MemoryStore(root, audit);

  await m.store("notes", "a", "the quick brown fox jumps over the lazy dog");
  await m.store("notes", "b", "lorem ipsum dolor sit amet consectetur");
  await m.store("notes", "c", "fox and hound are friends");

  const res = m.search("notes", "fox", 10);
  const keys = res.map((r) => r.key).sort();
  assert.deepEqual(keys, ["a", "c"]);
  m.close();
});

test("memory: invalid namespace rejects", async () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const m = new MemoryStore(root, audit);

  await assert.rejects(() => m.store("bad ns!", "k", "v"));
  await assert.rejects(() => m.store("ns; DROP TABLE", "k", "v"));
  m.close();
});

test("memory: SQL injection в search обрабатывается безопасно", async () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const m = new MemoryStore(root, audit);

  await m.store("ns", "k1", "hello world");
  // Попытка SQL-инъекции через query — должна просто ничего не вернуть
  // или искать литерально (но не выполнять SQL).
  const res = m.search("ns", "'; DROP TABLE memory; --", 10);
  assert.ok(Array.isArray(res));
  // База должна остаться целой.
  const r = m.get("ns", "k1");
  assert.ok(r);
  m.close();
});
