/**
 * Сравнительный бенчмарк v1 (FTS-only search) vs v2 (hybrid recall).
 *
 * Поток:
 *   1. Записать датасет (FTS-only — векторов ещё нет).
 *   2. backfill-embeddings — здесь однократно скачивается модель (~120MB) и
 *      считаются векторы.  ← это сетевой вызов; запускается явно пользователем.
 *   3. Прогнать запросы через search() и recall(), посчитать recall@5/@10 и MRR
 *      раздельно по типам запросов, вывести таблицу и сохранить JSON.
 *
 * Запуск: npm run bench
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryStore } from "../../src/memory/store.js";
import { AuditLogger } from "../../src/audit/logger.js";
import { backfillEmbeddings } from "../../src/cli/commands/backfill.js";
import { DATASET, type QueryType } from "./dataset.js";

const PROJECT_DIR = process.cwd();
// Стабильный воркспейс в системном temp: модель переиспользуется между прогонами,
// БД пересоздаётся каждый раз. Реальная память пользователя не затрагивается.
const WORKSPACE = path.join(os.tmpdir(), "safeflo-bench");

function recallAtK(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const topK = new Set(retrieved.slice(0, k));
  return expected.filter((e) => topK.has(e)).length / expected.length;
}

function reciprocalRank(retrieved: string[], expected: string[]): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (expected.includes(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}

interface Acc {
  recall5: number;
  recall10: number;
  mrr: number;
  n: number;
}

function emptyAcc(): Acc {
  return { recall5: 0, recall10: 0, mrr: 0, n: 0 };
}

function resetDb(): void {
  const dbBase = path.join(WORKSPACE, ".safeflow");
  for (const f of ["memory.db", "memory.db-wal", "memory.db-shm"]) {
    const p = path.join(dbBase, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(path.join(WORKSPACE, ".safeflow"), { recursive: true });
  resetDb();

  const audit = new AuditLogger(WORKSPACE);

  // 1. Запись датасета (namespace на кейс).
  const writer = new MemoryStore(WORKSPACE, audit);
  for (let i = 0; i < DATASET.length; i++) {
    const ns = `bench_${i}`;
    for (const rec of DATASET[i]!.storedRecords) {
      await writer.store(ns, rec.key, rec.content);
    }
  }
  writer.close();

  // 2. Backfill — скачивание модели + векторизация всех записей.
  console.error("[bench] backfilling embeddings (may download model ~120MB)…");
  await backfillEmbeddings(WORKSPACE);

  // 3. Прогон запросов.
  const store = new MemoryStore(WORKSPACE, audit);
  const v1: Record<QueryType, Acc> = {
    lexical: emptyAcc(),
    synonym: emptyAcc(),
    concept: emptyAcc(),
  };
  const v2: Record<QueryType, Acc> = {
    lexical: emptyAcc(),
    synonym: emptyAcc(),
    concept: emptyAcc(),
  };

  for (let i = 0; i < DATASET.length; i++) {
    const ns = `bench_${i}`;
    for (const q of DATASET[i]!.queries) {
      const oldKeys = store.search(ns, q.query, 10).map((r) => r.key);
      const newKeys = (
        await store.recall({ namespace: ns, query: q.query, limit: 10 })
      ).map((r) => r.key);

      const a1 = v1[q.type];
      a1.recall5 += recallAtK(oldKeys, q.expectedKeys, 5);
      a1.recall10 += recallAtK(oldKeys, q.expectedKeys, 10);
      a1.mrr += reciprocalRank(oldKeys, q.expectedKeys);
      a1.n += 1;

      const a2 = v2[q.type];
      a2.recall5 += recallAtK(newKeys, q.expectedKeys, 5);
      a2.recall10 += recallAtK(newKeys, q.expectedKeys, 10);
      a2.mrr += reciprocalRank(newKeys, q.expectedKeys);
      a2.n += 1;
    }
  }
  store.close();

  const types: QueryType[] = ["lexical", "synonym", "concept"];
  const summary = types.map((t) => {
    const a = v1[t];
    const b = v2[t];
    const avg = (x: number, n: number) => (n > 0 ? x / n : 0);
    return {
      type: t,
      n: a.n,
      v1: {
        recall5: avg(a.recall5, a.n),
        recall10: avg(a.recall10, a.n),
        mrr: avg(a.mrr, a.n),
      },
      v2: {
        recall5: avg(b.recall5, b.n),
        recall10: avg(b.recall10, b.n),
        mrr: avg(b.mrr, b.n),
      },
    };
  });

  // Таблица.
  const pp = (x: number) => (x * 100).toFixed(1);
  console.log("\n=== SafeFlo v2.0 search benchmark ===\n");
  console.log(
    "type     | n | v1 r@5 | v2 r@5 | Δr@5 | v1 r@10 | v2 r@10 | v1 MRR | v2 MRR",
  );
  console.log(
    "---------|---|--------|--------|------|---------|---------|--------|-------",
  );
  for (const s of summary) {
    const d = (s.v2.recall5 - s.v1.recall5) * 100;
    console.log(
      `${s.type.padEnd(8)} | ${String(s.n).padStart(1)} | ${pp(s.v1.recall5).padStart(6)} | ${pp(s.v2.recall5).padStart(6)} | ${(d >= 0 ? "+" : "") + d.toFixed(1)} | ${pp(s.v1.recall10).padStart(7)} | ${pp(s.v2.recall10).padStart(7)} | ${s.v1.mrr.toFixed(3)} | ${s.v2.mrr.toFixed(3)}`,
    );
  }
  console.log("");

  // Сохранение JSON.
  const outDir = path.join(PROJECT_DIR, "benchmark-results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `v2-comparison-${stamp}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        cases: DATASET.length,
        summary,
      },
      null,
      2,
    ),
  );
  console.log(`[bench] results saved: ${path.relative(PROJECT_DIR, outPath)}`);
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
