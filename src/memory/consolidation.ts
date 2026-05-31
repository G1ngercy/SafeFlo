/**
 * Consolidation — поиск кластеров близких эпизодических записей, которые
 * стоит обобщить в одну semantic-запись.
 *
 * ВАЖНО (принцип «no network»): здесь НЕТ ни эмбеддинга запросов, ни LLM.
 * Функция только читает уже посчитанные векторы из memory_vec и кластеризует
 * их жадной агломерацией по косинусной близости. Решение «что суммаризировать»
 * принимает LLM-клиент снаружи и сам вызывает memory_store(type='semantic').
 */

import type Database from "better-sqlite3";

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DEFAULT_OLDER_THAN_DAYS = 7;
const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_SIMILARITY = 0.7;
const SAMPLE_LIMIT = 3;

export interface ConsolidationOptions {
  namespace: string;
  olderThanDays?: number;
  minClusterSize?: number;
  similarityThreshold?: number;
}

export interface ConsolidationCluster {
  ids: number[];
  size: number;
  centroid: number[];
  samples: string[];
}

interface CandidateRow {
  id: number;
  content: string;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bufferToFloat32(buf: Buffer): Float32Array {
  // Копируем, чтобы не зависеть от выравнивания/жизненного цикла буфера.
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

/**
 * Возвращает кластеры эпизодических записей-кандидатов на консолидацию.
 * Жадная агломерация: для каждого ещё не охваченного seed-элемента собираем
 * все близкие (cosine ≥ threshold) ещё не охваченные элементы.
 */
export function findConsolidationCandidates(
  db: Database.Database,
  opts: ConsolidationOptions,
): ConsolidationCluster[] {
  const olderThanDays = opts.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
  const minClusterSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY;

  const cutoffIso = new Date(
    Date.now() - olderThanDays * MS_PER_DAY,
  ).toISOString();

  const rows = db
    .prepare(
      `SELECT m.rowid AS id, m.content AS content
       FROM memory m
       WHERE m.namespace = ?
         AND m.memory_type = 'episodic'
         AND m.superseded_by IS NULL
         AND m.created_at < ?
       ORDER BY m.rowid`,
    )
    .all(opts.namespace, cutoffIso) as CandidateRow[];

  if (rows.length < minClusterSize) return [];

  // Подгружаем векторы; записи без вектора исключаются из кластеризации.
  const placeholders = rows.map(() => "?").join(",");
  const vecRows = db
    .prepare(
      `SELECT memory_id AS id, embedding FROM memory_vec
       WHERE memory_id IN (${placeholders})`,
    )
    .all(...rows.map((r) => r.id)) as { id: number; embedding: Buffer }[];

  const vecById = new Map<number, Float32Array>();
  for (const v of vecRows) vecById.set(v.id, bufferToFloat32(v.embedding));

  const contentById = new Map<number, string>();
  for (const r of rows) contentById.set(r.id, r.content);

  const ids = rows.map((r) => r.id).filter((id) => vecById.has(id));
  if (ids.length < minClusterSize) return [];

  const visited = new Set<number>();
  const clusters: ConsolidationCluster[] = [];

  for (const seed of ids) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    const seedVec = vecById.get(seed)!;
    const cluster = [seed];

    for (const other of ids) {
      if (visited.has(other)) continue;
      const sim = cosine(seedVec, vecById.get(other)!);
      if (sim >= threshold) {
        cluster.push(other);
        visited.add(other);
      }
    }

    if (cluster.length >= minClusterSize) {
      clusters.push({
        ids: cluster,
        size: cluster.length,
        centroid: centroidOf(cluster.map((id) => vecById.get(id)!)),
        samples: cluster
          .slice(0, SAMPLE_LIMIT)
          .map((id) => contentById.get(id) ?? ""),
      });
    }
  }

  return clusters;
}

function centroidOf(vectors: Float32Array[]): number[] {
  const dim = vectors[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  }
  return sum.map((s) => s / vectors.length);
}
