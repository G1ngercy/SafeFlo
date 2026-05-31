/**
 * HybridSearch — объединение лексического (FTS5) и семантического (sqlite-vec)
 * поиска через Reciprocal Rank Fusion (RRF).
 *
 * Деградация: если эмбеддингов нет (модель не скачана / опт-аут), векторная
 * ветка молча возвращает пусто, и поиск работает как FTS-only.
 *
 * Совместимость со схемой: таблица memory не имеет колонки id — используем
 * неявный rowid (он же ключ memory_vec.memory_id).
 */

import type Database from "better-sqlite3";
import { EmbeddingService } from "./embedding.js";

export type MemoryType = "episodic" | "semantic" | "procedural";

export interface SearchOptions {
  namespace: string;
  query: string;
  limit?: number;
  memoryTypes?: MemoryType[];
  includeSuperseded?: boolean;
}

export interface ScoredMemory {
  id: number;
  key: string;
  content: string;
  score: number;
  matchedBy: ("fts" | "vec")[];
}

const RRF_K = 60;
const CANDIDATE_MULTIPLIER = 4;
const RECENCY_HALFLIFE_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

interface MemoryRow {
  id: number;
  key: string;
  content: string;
  importance: number | null;
  last_accessed_at: number | null;
  created_at: string | null;
}

export class HybridSearch {
  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingService,
  ) {}

  async search(opts: SearchOptions): Promise<ScoredMemory[]> {
    const limit = opts.limit ?? 10;
    const candidates = limit * CANDIDATE_MULTIPLIER;

    const [ftsHits, vecHits] = await Promise.all([
      Promise.resolve(this.ftsSearch(opts, candidates)),
      // Векторный поиск молча падает обратно к FTS-only, если эмбеддингов нет.
      this.vectorSearch(opts, candidates).catch(() => [] as number[]),
    ]);

    // Reciprocal Rank Fusion.
    const merged = new Map<number, { score: number; sources: Set<string> }>();
    const fuse = (ids: number[], source: string) => {
      ids.forEach((id, rank) => {
        const e = merged.get(id) ?? { score: 0, sources: new Set<string>() };
        e.score += 1 / (RRF_K + rank + 1);
        e.sources.add(source);
        merged.set(id, e);
      });
    };
    fuse(ftsHits, "fts");
    fuse(vecHits, "vec");

    if (merged.size === 0) return [];

    const ids = [...merged.keys()];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT rowid AS id, key, content, importance, last_accessed_at, created_at
         FROM memory
         WHERE rowid IN (${placeholders})`,
      )
      .all(...ids) as MemoryRow[];

    const now = Date.now();
    const scored: ScoredMemory[] = rows.map((row) => {
      const base = merged.get(row.id)!;
      const refTs = this.referenceTimestamp(row, now);
      const days = (now - refTs) / MS_PER_DAY;
      const recencyBoost = Math.exp((-Math.LN2 * days) / RECENCY_HALFLIFE_DAYS);
      const importance = row.importance ?? 0.5;
      const finalScore =
        base.score * (1 + 0.3 * importance + 0.2 * recencyBoost);
      return {
        id: row.id,
        key: row.key,
        content: row.content,
        score: finalScore,
        matchedBy: [...base.sources] as ("fts" | "vec")[],
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    // Access stats (importance reinforcement / recency).
    if (top.length > 0) {
      const updateStmt = this.db.prepare(
        `UPDATE memory
         SET last_accessed_at = ?, access_count = access_count + 1
         WHERE rowid = ?`,
      );
      const tx = this.db.transaction(() => {
        for (const s of top) updateStmt.run(now, s.id);
      });
      tx();
    }

    return top;
  }

  /**
   * Опорный timestamp для recency: last_accessed_at (epoch ms) если есть,
   * иначе created_at (ISO TEXT в схеме v1) распарсенный в ms, иначе now.
   */
  private referenceTimestamp(row: MemoryRow, now: number): number {
    if (typeof row.last_accessed_at === "number") return row.last_accessed_at;
    if (row.created_at) {
      const parsed = Date.parse(row.created_at);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return now;
  }

  private ftsSearch(opts: SearchOptions, limit: number): number[] {
    const q = this.sanitizeFtsQuery(opts.query);
    if (!q) return [];

    const types = opts.memoryTypes ? JSON.stringify(opts.memoryTypes) : null;
    const sql = `
      SELECT m.rowid AS id
      FROM memory_fts f
      JOIN memory m ON m.rowid = f.rowid
      WHERE memory_fts MATCH ?
        AND m.namespace = ?
        AND (? = 1 OR m.superseded_by IS NULL)
        ${types ? "AND m.memory_type IN (SELECT value FROM json_each(?))" : ""}
      ORDER BY rank
      LIMIT ?
    `;
    const params: (string | number)[] = [
      q,
      opts.namespace,
      opts.includeSuperseded ? 1 : 0,
    ];
    if (types) params.push(types);
    params.push(limit);

    return (this.db.prepare(sql).all(...params) as { id: number }[]).map(
      (r) => r.id,
    );
  }

  private async vectorSearch(
    opts: SearchOptions,
    limit: number,
  ): Promise<number[]> {
    if (this.embeddings.needsDownload()) return [];

    const vec = await this.embeddings.embedOne(opts.query);
    const types = opts.memoryTypes ? JSON.stringify(opts.memoryTypes) : null;
    const sql = `
      SELECT v.memory_id AS id, v.distance AS distance
      FROM memory_vec v
      JOIN memory m ON m.rowid = v.memory_id
      WHERE v.embedding MATCH ?
        AND k = ?
        AND m.namespace = ?
        AND (? = 1 OR m.superseded_by IS NULL)
        ${types ? "AND m.memory_type IN (SELECT value FROM json_each(?))" : ""}
      ORDER BY distance
    `;
    const params: (Buffer | string | number)[] = [
      Buffer.from(vec.buffer),
      limit,
      opts.namespace,
      opts.includeSuperseded ? 1 : 0,
    ];
    if (types) params.push(types);

    return (this.db.prepare(sql).all(...params) as { id: number }[]).map(
      (r) => r.id,
    );
  }

  /**
   * Превращает свободный запрос в безопасный FTS5 prefix-OR.
   * Спецсимволы FTS5 вырезаются — пользовательский ввод никогда не попадает
   * в синтаксис запроса напрямую.
   */
  private sanitizeFtsQuery(query: string): string {
    const cleaned = query.replace(/["()*]/g, " ").trim();
    const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t}"*`).join(" OR ");
  }
}
