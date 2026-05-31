/**
 * backfill-embeddings — досчитывает векторы для записей, у которых их ещё нет
 * (например, добавленных в режиме FTS-only или мигрированных из v1).
 *
 * ВНИМАНИЕ (safety): реальный прогон (без --dry-run) при первом запуске
 * скачивает модель эмбеддингов (~120MB). Это явная пользовательская команда —
 * согласие выражается самим её запуском. --dry-run сети не касается.
 */

import Database from "better-sqlite3";
import * as path from "node:path";

import { EmbeddingService } from "../../memory/embedding.js";
import { ensureVecLoaded } from "../../storage/migrations.js";

const BATCH_SIZE = 32;

export interface BackfillOptions {
  namespace?: string;
  dryRun?: boolean;
}

export async function backfillEmbeddings(
  projectDir: string,
  opts: BackfillOptions = {},
): Promise<{ pending: number; embedded: number }> {
  const safeflowDir = path.join(projectDir, ".safeflow");
  const dbPath = path.join(safeflowDir, "memory.db");
  const db = new Database(dbPath);
  ensureVecLoaded(db);

  try {
    const embedSvc = new EmbeddingService(safeflowDir);

    // Записи без вектора. memory не имеет колонки id — используем rowid.
    const baseSql = `
      SELECT m.rowid AS id, m.content AS content
      FROM memory m
      LEFT JOIN memory_vec v ON v.memory_id = m.rowid
      WHERE v.memory_id IS NULL
    `;
    const rows = (
      opts.namespace
        ? db.prepare(baseSql + " AND m.namespace = ?").all(opts.namespace)
        : db.prepare(baseSql).all()
    ) as { id: number; content: string }[];

    console.error(`[backfill] ${rows.length} records pending`);
    if (opts.dryRun || rows.length === 0) {
      return { pending: rows.length, embedded: 0 };
    }

    const insertVec = db.prepare(
      "INSERT OR REPLACE INTO memory_vec(memory_id, embedding) VALUES (?, ?)",
    );

    let embedded = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const vecs = await embedSvc.embed(batch.map((r) => r.content));
      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          insertVec.run(batch[j]!.id, Buffer.from(vecs[j]!.buffer));
        }
      });
      tx();
      embedded += batch.length;
      console.error(
        `[backfill] ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`,
      );
    }
    return { pending: rows.length, embedded };
  } finally {
    db.close();
  }
}
