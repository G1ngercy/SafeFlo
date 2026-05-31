import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { MemoryStore } from "../dist/memory/store.js";
import { AuditLogger } from "../dist/audit/logger.js";
import { ensureVecLoaded } from "../dist/storage/migrations.js";
import { findConsolidationCandidates } from "../dist/memory/consolidation.js";

const DIM = 384;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safeflow-consol-"));
}

// Нормализованный вектор: одна доминирующая ось + лёгкий шум.
function unitVec(axis, noiseAxis) {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  if (noiseAxis !== undefined) v[noiseAxis] = 0.05;
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

test("consolidation: groups two distinct episodic clusters of size >= 3", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  for (const [k, c] of [
    ["a1", "we discussed database indexing"],
    ["a2", "database query performance tuning"],
    ["a3", "more database schema talk"],
    ["b1", "deployment pipeline notes"],
    ["b2", "deploy to production steps"],
    ["b3", "rollback during deploy"],
    ["outlier", "lunch menu for friday"],
  ]) {
    await m.store("ns", k, c);
  }
  m.close();

  const dbPath = path.join(root, ".safeflow", "memory.db");
  const db = new Database(dbPath);
  ensureVecLoaded(db);

  // Состарим записи (старше 7 дней) и вставим синтетические векторы.
  const oldIso = new Date(Date.now() - 30 * 86400000).toISOString();
  db.prepare("UPDATE memory SET created_at = ?").run(oldIso);

  const insert = db.prepare(
    "INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)",
  );
  const rows = db.prepare("SELECT rowid AS id, key FROM memory").all();
  for (const r of rows) {
    let vec;
    if (r.key.startsWith("a")) vec = unitVec(0, r.id % 5);
    else if (r.key.startsWith("b")) vec = unitVec(100, r.id % 5);
    else vec = unitVec(200);
    insert.run(BigInt(r.id), Buffer.from(vec.buffer));
  }

  const clusters = findConsolidationCandidates(db, { namespace: "ns" });
  assert.equal(clusters.length, 2, "two clusters found");
  for (const c of clusters) {
    assert.ok(c.size >= 3);
    assert.equal(c.centroid.length, DIM);
    assert.ok(c.samples.length >= 1 && c.samples.length <= 3);
  }
  db.close();
});

test("consolidation: returns empty when fewer than min cluster size", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  await m.store("ns", "only", "single old record");
  m.close();

  const db = new Database(path.join(root, ".safeflow", "memory.db"));
  ensureVecLoaded(db);
  db.prepare("UPDATE memory SET created_at = ?").run(
    new Date(Date.now() - 30 * 86400000).toISOString(),
  );
  const clusters = findConsolidationCandidates(db, { namespace: "ns" });
  assert.deepEqual(clusters, []);
  db.close();
});

test("consolidation: recent records are excluded by age filter", async () => {
  const root = mkTmp();
  const m = new MemoryStore(root, new AuditLogger(root));
  for (const k of ["a1", "a2", "a3"]) await m.store("ns", k, "fresh record");
  m.close();

  const db = new Database(path.join(root, ".safeflow", "memory.db"));
  ensureVecLoaded(db);
  // created_at оставляем «сейчас» (по умолчанию) — записи моложе 7 дней.
  const insert = db.prepare(
    "INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)",
  );
  for (const r of db.prepare("SELECT rowid AS id FROM memory").all()) {
    insert.run(BigInt(r.id), Buffer.from(unitVec(0).buffer));
  }
  const clusters = findConsolidationCandidates(db, { namespace: "ns" });
  assert.deepEqual(clusters, [], "recent records excluded");
  db.close();
});
