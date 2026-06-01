# SafeFlo v2.0 — Полное задание

**Режим работы:** одна сессия, всё задание целиком.
**Оценка времени:** 1-3 часа активной работы.
**Финал:** PR в `main` с обновлённой реализацией, документацией и зелёными тестами.

---

## Контекст

Текущая `MemoryStore` использует только SQLite FTS5 — лексический поиск. Это плохо работает на перефразированных запросах: запись «решили использовать SQLite» не находится по запросу «какую БД мы выбрали». Для AI-агента это критично.

Также текущая реализация называется «agent memory», но фактически это key-value хранилище без жизненного цикла: нет типов памяти, нет importance, нет supersession устаревших фактов, нет консолидации эпизодов в обобщённые знания.

Задача v2.0 — устранить оба недостатка. Сделать настоящий гибридный поиск и настоящий lifecycle памяти.

## Что делаем — обзор

1. **Migration framework** с автобэкапом и schema versioning
2. **Hybrid search:** FTS5 + векторные эмбеддинги через `sqlite-vec`, объединение через Reciprocal Rank Fusion
3. **Memory lifecycle:** типы (episodic/semantic/procedural), importance, supersession, access tracking
4. **Consolidation tool:** кластеризация старых эпизодов и подготовка материала для semantic-резюме
5. **Бенчмарк** до/после, доказывающий улучшение recall
6. **API refactor + честный README**

Backward compatibility: все существующие MCP-инструменты должны продолжать работать. Новые имена — алиасами рядом со старыми.

---

## Подготовка

```bash
git status                                  # должно быть clean
git checkout main && git pull
git tag v1.0.0-baseline
git push origin v1.0.0-baseline
git checkout -b feat/v2-hybrid-memory       # ветка для всей работы
```

Все коммиты идут в `feat/v2-hybrid-memory`. Делай осмысленные коммиты по мере прогресса, не один большой в конце.

---

## Раздел 1: Migration Framework

**Цель:** инфраструктура версионирования схемы с автобэкапом, чтобы все последующие изменения шли через неё.

Создай `src/storage/migrations.ts`:

```typescript
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_baseline',
    up: () => { /* no-op: маркирует существующую v1 схему */ },
  },
  // Миграции v2, v3 добавляются ниже по ходу разработки
];

export function migrate(db: Database.Database, dbPath: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const memoryTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory'"
  ).get();

  const currentVersion = (db.prepare(
    'SELECT MAX(version) as v FROM schema_version'
  ).get() as { v: number | null }).v ?? 0;

  // Унаследованные БД v1 — маркируем без изменений
  if (memoryTableExists && currentVersion === 0) {
    db.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(
      1, 'initial_baseline', Date.now()
    );
  }

  const applied = (db.prepare(
    'SELECT MAX(version) as v FROM schema_version'
  ).get() as { v: number | null }).v ?? 0;

  const pending = MIGRATIONS.filter(m => m.version > applied);
  if (pending.length === 0) return;

  // Автобэкап перед изменениями
  if (fs.existsSync(dbPath)) {
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(
      backupDir,
      `memory.db.pre-v${applied + 1}-${Date.now()}.bak`
    );
    fs.copyFileSync(dbPath, backupPath);
    console.error(`[migrate] backup: ${backupPath}`);
  }

  const tx = db.transaction(() => {
    for (const m of pending) {
      console.error(`[migrate] applying v${m.version}: ${m.name}`);
      m.up(db);
      db.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(
        m.version, m.name, Date.now()
      );
    }
  });
  tx();
}
```

В конструкторе `MemoryStore` после открытия БД вызывай `migrate(this.db, dbPath)`.

Напиши unit-тесты на migration framework: что v1-БД маркируется, что новые миграции применяются в транзакции, что бэкап создаётся.

**Коммит:** `feat(storage): add schema versioning and migration framework`

---

## Раздел 2: Зависимости и EmbeddingService

Установи:

```bash
npm install sqlite-vec @xenova/transformers
npm install --save-dev tsx
```

**ВАЖНО:** перед первым запуском кода, который вызывает `pipeline()` из `@xenova/transformers`, спроси у пользователя разрешение. Это скачает ~120MB модель. Используй формулировку: «Готов запустить EmbeddingService — это скачает модель `paraphrase-multilingual-MiniLM-L12-v2` (~120MB) из Hugging Face в `.safeflow/models/`. Разрешаешь?»

Создай `src/memory/embedding.ts`:

```typescript
import * as path from 'path';
import * as fs from 'fs';

const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIM = 384;

export class EmbeddingService {
  private pipelinePromise: Promise<any> | null = null;
  private modelCacheDir: string;

  constructor(safeflowDir: string) {
    this.modelCacheDir = path.join(safeflowDir, 'models');
    fs.mkdirSync(this.modelCacheDir, { recursive: true });
  }

  needsDownload(): boolean {
    const modelPath = path.join(
      this.modelCacheDir,
      MODEL_ID.replace('/', path.sep)
    );
    return !fs.existsSync(modelPath);
  }

  private async getPipeline() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const transformers = await import('@xenova/transformers');
        transformers.env.cacheDir = this.modelCacheDir;
        transformers.env.allowRemoteModels = true;
        transformers.env.allowLocalModels = true;
        return transformers.pipeline('feature-extraction', MODEL_ID, {
          quantized: true,
        });
      })();
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const model = await this.getPipeline();
    const output = await model(texts, { pooling: 'mean', normalize: true });
    const dim = output.dims[output.dims.length - 1];
    if (dim !== EMBEDDING_DIM) {
      throw new Error(`Expected dim ${EMBEDDING_DIM}, got ${dim}`);
    }
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(new Float32Array(
        output.data.slice(i * dim, (i + 1) * dim)
      ));
    }
    return result;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [v] = await this.embed([text]);
    return v;
  }
}
```

**Коммит:** `feat(memory): add EmbeddingService with multilingual model`

---

## Раздел 3: Векторное хранилище

Добавь миграцию v2 в `src/storage/migrations.ts`:

```typescript
import * as sqliteVec from 'sqlite-vec';

MIGRATIONS.push({
  version: 2,
  name: 'add_memory_vec_table',
  up: (db) => {
    sqliteVec.load(db);
    db.exec(`
      CREATE VIRTUAL TABLE memory_vec USING vec0(
        memory_id INTEGER PRIMARY KEY,
        embedding FLOAT[384]
      )
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_vec_cleanup
      AFTER DELETE ON memory
      BEGIN
        DELETE FROM memory_vec WHERE memory_id = old.id;
      END
    `);
  },
});
```

В `MemoryStore` после открытия БД и перед `migrate()` загружай sqlite-vec:

```typescript
import * as sqliteVec from 'sqlite-vec';
// ...
this.db = new Database(dbPath);
sqliteVec.load(this.db);
migrate(this.db, dbPath);
```

При записи в `memory_store` (после успешного INSERT в `memory`) — сразу считай эмбеддинг и пиши в `memory_vec`. Если EmbeddingService падает (модель не скачана, опт-аут) — лог, но не блокируй запись. Это важный fallback.

**Коммит:** `feat(memory): add vector storage via sqlite-vec`

---

## Раздел 4: HybridSearch с RRF

Создай `src/memory/hybrid-search.ts`:

```typescript
import type Database from 'better-sqlite3';
import { EmbeddingService } from './embedding';

interface SearchOptions {
  namespace: string;
  query: string;
  limit?: number;
  memoryTypes?: ('episodic' | 'semantic' | 'procedural')[];
  includeSuperseded?: boolean;
}

interface ScoredMemory {
  id: number;
  key: string;
  content: string;
  score: number;
  matchedBy: ('fts' | 'vec')[];
}

const RRF_K = 60;
const CANDIDATE_MULTIPLIER = 4;

export class HybridSearch {
  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingService,
  ) {}

  async search(opts: SearchOptions): Promise<ScoredMemory[]> {
    const limit = opts.limit ?? 10;
    const candidates = limit * CANDIDATE_MULTIPLIER;

    const [ftsHits, vecHits] = await Promise.all([
      this.ftsSearch(opts, candidates),
      this.vectorSearch(opts, candidates).catch(() => [] as number[]),
      //  ^ vector search молча падает обратно к FTS-only, если эмбеддингов нет
    ]);

    // Reciprocal Rank Fusion
    const merged = new Map<number, { score: number; sources: Set<string> }>();
    ftsHits.forEach((id, rank) => {
      const e = merged.get(id) ?? { score: 0, sources: new Set() };
      e.score += 1 / (RRF_K + rank + 1);
      e.sources.add('fts');
      merged.set(id, e);
    });
    vecHits.forEach((id, rank) => {
      const e = merged.get(id) ?? { score: 0, sources: new Set() };
      e.score += 1 / (RRF_K + rank + 1);
      e.sources.add('vec');
      merged.set(id, e);
    });

    if (merged.size === 0) return [];

    const ids = [...merged.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, key, content, importance, last_accessed_at, created_at
      FROM memory
      WHERE id IN (${placeholders})
    `).all(...ids) as any[];

    const now = Date.now();
    const scored: ScoredMemory[] = rows.map(row => {
      const base = merged.get(row.id)!;
      const refTs = row.last_accessed_at ?? row.created_at ?? now;
      const days = (now - refTs) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.exp(-Math.LN2 * days / 30);
      const importance = row.importance ?? 0.5;
      const finalScore = base.score * (1 + 0.3 * importance + 0.2 * recencyBoost);
      return {
        id: row.id,
        key: row.key,
        content: row.content,
        score: finalScore,
        matchedBy: [...base.sources] as ('fts' | 'vec')[],
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    // Запись access stats (для importance reinforcement)
    if (top.length > 0) {
      const updateStmt = this.db.prepare(`
        UPDATE memory 
        SET last_accessed_at = ?, access_count = access_count + 1 
        WHERE id = ?
      `);
      const tx = this.db.transaction(() => {
        for (const s of top) updateStmt.run(now, s.id);
      });
      tx();
    }

    return top;
  }

  private ftsSearch(opts: SearchOptions, limit: number): number[] {
    const q = this.sanitizeFtsQuery(opts.query);
    if (!q) return [];
    
    const types = opts.memoryTypes ? JSON.stringify(opts.memoryTypes) : null;
    const sql = `
      SELECT m.id
      FROM memory_fts f
      JOIN memory m ON m.id = f.rowid
      WHERE memory_fts MATCH ?
        AND m.namespace = ?
        AND (? = 1 OR m.superseded_by IS NULL)
        ${types ? `AND m.memory_type IN (SELECT value FROM json_each(?))` : ''}
      ORDER BY rank
      LIMIT ?
    `;
    const params: any[] = [q, opts.namespace, opts.includeSuperseded ? 1 : 0];
    if (types) params.push(types);
    params.push(limit);
    
    return (this.db.prepare(sql).all(...params) as { id: number }[]).map(r => r.id);
  }

  private async vectorSearch(opts: SearchOptions, limit: number): Promise<number[]> {
    if (this.embeddings.needsDownload()) return [];
    
    const vec = await this.embeddings.embedOne(opts.query);
    const sql = `
      SELECT v.memory_id as id, distance
      FROM memory_vec v
      JOIN memory m ON m.id = v.memory_id
      WHERE v.embedding MATCH ?
        AND k = ?
        AND m.namespace = ?
        AND (? = 1 OR m.superseded_by IS NULL)
      ORDER BY distance
    `;
    return (this.db.prepare(sql).all(
      Buffer.from(vec.buffer), limit, opts.namespace,
      opts.includeSuperseded ? 1 : 0,
    ) as { id: number }[]).map(r => r.id);
  }

  private sanitizeFtsQuery(query: string): string {
    // Удаляем FTS5 спецсимволы, превращаем в безопасный prefix-поиск
    const cleaned = query.replace(/["\(\)\*]/g, ' ').trim();
    const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return '';
    return tokens.map(t => `"${t}"*`).join(' OR ');
  }
}
```

Добавь метод `recall()` в `MemoryStore`, который использует `HybridSearch`. Старый `search()` сохрани как deprecated-алиас, который внутри вызывает `recall()`.

**Коммит:** `feat(memory): hybrid search with FTS5 + vectors via RRF fusion`

---

## Раздел 5: Memory Lifecycle

Миграция v3:

```typescript
MIGRATIONS.push({
  version: 3,
  name: 'add_memory_lifecycle_fields',
  up: (db) => {
    db.exec(`
      ALTER TABLE memory ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'episodic';
      ALTER TABLE memory ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;
      ALTER TABLE memory ADD COLUMN created_at INTEGER;
      ALTER TABLE memory ADD COLUMN last_accessed_at INTEGER;
      ALTER TABLE memory ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory ADD COLUMN superseded_by INTEGER REFERENCES memory(id);
      ALTER TABLE memory ADD COLUMN superseded_at INTEGER;
      ALTER TABLE memory ADD COLUMN source TEXT;
      ALTER TABLE memory ADD COLUMN consolidated_from TEXT;
    `);
    // Backfill created_at для старых записей (приблизительно по rowid)
    db.exec(`
      UPDATE memory SET created_at = strftime('%s','now') * 1000 
      WHERE created_at IS NULL;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_ns_type 
        ON memory(namespace, memory_type) WHERE superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_importance 
        ON memory(namespace, importance DESC) WHERE superseded_by IS NULL;
    `);
  },
});
```

Создай `src/memory/importance.ts`:

```typescript
export type MemoryType = 'episodic' | 'semantic' | 'procedural';

const KEYWORDS = /реши(ли|л)|договорились|важно|критично|обязательно|никогда|всегда|decided|agreed|important|critical|must|never|always|TODO|FIXME/i;

export function defaultImportance(content: string, type: MemoryType): number {
  let score = 0.5;
  if (type === 'semantic') score += 0.15;
  if (type === 'procedural') score += 0.20;
  if (KEYWORDS.test(content)) score += 0.10;
  if (content.length > 500) score += 0.05;
  if (content.length < 50) score -= 0.05;
  return Math.max(0, Math.min(1, score));
}
```

Расширь сигнатуру `memory_store` MCP-инструмента: добавь опциональные поля `memory_type`, `importance`, `source`. Если не переданы — используй дефолты. Дефолт `importance` берётся из `defaultImportance()`.

Добавь новый MCP-инструмент `memory_supersede(old_id, new_content, reason)`:

```typescript
supersede(oldId: number, newContent: string, reason: string): number {
  return this.db.transaction(() => {
    const old = this.db.prepare('SELECT * FROM memory WHERE id = ?').get(oldId) as any;
    if (!old) throw new Error(`memory ${oldId} not found`);
    
    const newId = this.storeInternal({
      namespace: old.namespace,
      key: `${old.key}-v${Date.now()}`,
      content: newContent,
      memory_type: old.memory_type,
      importance: Math.min(1, old.importance + 0.1),
      source: JSON.stringify({ supersedes: oldId, reason }),
    });
    
    this.db.prepare(
      'UPDATE memory SET superseded_by = ?, superseded_at = ? WHERE id = ?'
    ).run(newId, Date.now(), oldId);
    
    this.audit.log('memory.supersede', { oldId, newId, reason });
    return newId;
  })();
}
```

**Коммит:** `feat(memory): lifecycle — types, importance, supersession, access tracking`

---

## Раздел 6: Backfill команда

Создай CLI-команду `backfill-embeddings` в `src/cli/commands/backfill.ts`:

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as path from 'path';
import { EmbeddingService } from '../../memory/embedding';

const BATCH_SIZE = 32;

export async function backfillEmbeddings(projectDir: string, opts: {
  namespace?: string;
  dryRun?: boolean;
} = {}) {
  const dbPath = path.join(projectDir, '.safeflow', 'memory.db');
  const db = new Database(dbPath);
  sqliteVec.load(db);

  const embedSvc = new EmbeddingService(path.join(projectDir, '.safeflow'));

  const baseSql = `
    SELECT m.id, m.content FROM memory m
    LEFT JOIN memory_vec v ON v.memory_id = m.id
    WHERE v.memory_id IS NULL
  `;
  const rows = (opts.namespace
    ? db.prepare(baseSql + ' AND m.namespace = ?').all(opts.namespace)
    : db.prepare(baseSql).all()
  ) as { id: number; content: string }[];

  console.error(`[backfill] ${rows.length} records pending`);
  if (opts.dryRun || rows.length === 0) return;

  const insertVec = db.prepare(
    'INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)'
  );

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const vecs = await embedSvc.embed(batch.map(r => r.content));
    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        insertVec.run(batch[j].id, Buffer.from(vecs[j].buffer));
      }
    });
    tx();
    console.error(`[backfill] ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }
}
```

Подключи к CLI: `safeflow backfill-embeddings [--namespace=X] [--dry-run]`.

**Коммит:** `feat(cli): backfill-embeddings command for existing records`

---

## Раздел 7: Consolidation

Создай `src/memory/consolidation.ts` с функцией `findConsolidationCandidates()`, которая:

1. Берёт episodic-записи старше N дней (по умолчанию 7), не superseded
2. Загружает их эмбеддинги из `memory_vec`
3. Жадно агломерирует по косинусной близости ≥ 0.7
4. Возвращает кластеры с ≥3 записями: их ID, центроид, первые 3 контента как samples

Добавь MCP-инструмент `memory_consolidate(namespace, dry_run?)`:
- `dry_run=true` (по умолчанию) → возвращает найденные кластеры с samples
- Сам LLM-клиент решает, что суммаризировать, и вызывает `memory_store(..., type='semantic', consolidated_from=[ids])` отдельно

Сервер сам никаких LLM-вызовов не делает. Это важно — поддерживаем принцип «no network calls».

Код кластеризации — см. предыдущие обсуждения. Жадная агломерация по cosine similarity, без k-means, без сторонних библиотек.

**Коммит:** `feat(memory): consolidation tool for episodic clustering`

---

## Раздел 8: Бенчмарк

Создай `test/benchmark/dataset.ts` с минимум **6 кейсами**, каждый с 4-8 записями и 4-6 запросами трёх типов:

- `lexical` — точные слова из записи присутствуют в запросе
- `synonym` — те же концепции, другими словами
- `concept` — общая тема, конкретные слова не упомянуты

Смешивай русский и английский — это типично для разработки.

```typescript
export interface BenchmarkCase {
  description: string;
  storedRecords: { key: string; content: string }[];
  queries: {
    query: string;
    type: 'lexical' | 'synonym' | 'concept';
    expectedKeys: string[];
  }[];
}
```

Создай `test/benchmark/run.ts`, который:

1. Прогоняет dataset через и старый `search()`, и новый `recall()`
2. Считает recall@5, recall@10, MRR — раздельно по типам запросов
3. Выводит таблицу сравнения
4. Сохраняет результаты в `benchmark-results/v2-comparison-<timestamp>.json`

Метрики:

```typescript
function recallAtK(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const topK = new Set(retrieved.slice(0, k));
  return expected.filter(e => topK.has(e)).length / expected.length;
}

function reciprocalRank(retrieved: string[], expected: string[]): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (expected.includes(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}
```

В `package.json`:

```json
"scripts": {
  "bench": "tsx test/benchmark/run.ts"
}
```

**Ожидаемый результат:** на запросах типа `synonym` и `concept` recall@5 нового `recall()` должен быть на ≥20 процентных пунктов выше старого `search()`. На `lexical` — примерно равен.

Если этого не происходит — НЕ подгоняй dataset. Останавливайся и докладывай, разбираемся.

**Коммит:** `test(bench): comparative benchmark v1 vs v2 search`

---

## Раздел 9: API restructure

Добавь новые MCP-инструменты (рядом со старыми):

- `memory_recall` — алиас для бывшего `memory_search` (новое имя, более точное)
- `memory_supersede` — новый
- `memory_consolidate` — новый

Старые имена оставь работающими. В `description` старых добавь префикс `[DEPRECATED, use <new_name>]`.

Не удаляй старые инструменты — это будет в v3.0.

**Коммит:** `feat(mcp): new memory_recall/supersede/consolidate tools, deprecate old aliases`

---

## Раздел 10: Документация

### README.md

1. Удали слово **orchestration** из заголовка и описания, замени на «agent memory».
2. Удали сравнительные матрицы с другими MCP-серверами по количеству инструментов — это не наша забота.
3. Добавь раздел **Memory model:** episodic/semantic/procedural, lifecycle, supersession, consolidation. Кратко, по одному абзацу на каждое.
4. Добавь раздел **Search:** «Hybrid: FTS5 для лексического + sqlite-vec для семантического, объединение через Reciprocal Rank Fusion».
5. Добавь раздел **Trade-offs and limitations:**
   - Первичная загрузка модели эмбеддингов требует сети (~120MB)
   - Нативные модули: `better-sqlite3` и `sqlite-vec`
   - На объёмах >100k записей нужны другие решения
6. Добавь раздел **Benchmark** с числами из бенчмарка.

### SECURITY.md

Текущее обещание «no network calls» больше не верно буквально. Замени на:

```markdown
## Network calls

SafeFlo does not make network calls during memory operations at runtime.

One-time exception: the embedding model (~120MB) is downloaded from 
Hugging Face on first use, into `./.safeflow/models/`. After this download, 
no further network access is required.

You can opt out entirely by passing `--no-embeddings` to `safeflow init`. 
In that mode, SafeFlo falls back to FTS5-only search.
```

### CHANGELOG.md

```markdown
## v2.0.0

### Added
- Hybrid search: FTS5 + vector embeddings via sqlite-vec
- Memory lifecycle: types (episodic/semantic/procedural), importance, supersession, access tracking
- memory_consolidate tool for episodic→semantic promotion
- memory_supersede tool for replacing outdated facts
- backfill-embeddings CLI for existing records
- Schema versioning and migration framework with automatic backups

### Changed
- memory_search renamed to memory_recall (old name kept as deprecated alias)
- README rewritten to remove "orchestration" framing, added honest description
- SECURITY.md: clarified one-time model download requirement

### Migration
v1 databases auto-upgrade on first v2 launch.
Backup created at `./.safeflow/backups/` before any schema change.
Run `safeflow backfill-embeddings` to populate vectors for existing records.

### Breaking changes
None at runtime — all v1 APIs preserved as deprecated aliases.
Removal of deprecated aliases planned for v3.0.
```

В `package.json` подними версию: `"version": "2.0.0"`.

**Коммит:** `docs: README, SECURITY, CHANGELOG for v2.0`

---

## Финальная проверка

Прежде чем заканчивать, прогони полный набор:

```bash
npm ci                  # должно пройти без ошибок
npm run build           # должно собраться
npm test                # все тесты зелёные
npm run lint            # без новых warnings
npm run bench           # числа улучшились на synonym/concept запросах
```

Если что-то падает — **останавливайся, не игнорируй**. Опиши проблему в финальном отчёте.

---

## Тест миграции на песочнице

Прежде чем считать работу законченной — проверь, что миграция v1→v2 на реалистичной БД проходит:

```bash
# Создай песочницу с v1-БД (имитация старого состояния)
mkdir -p /tmp/safeflow-sandbox-test/.safeflow
# Вставь туда руками или через скрипт несколько записей старого формата
# Затем запусти инициализацию MemoryStore — должна сработать миграция
# Проверь:
sqlite3 /tmp/safeflow-sandbox-test/.safeflow/memory.db "SELECT * FROM schema_version;"
# Должны быть строки v1, v2, v3
sqlite3 /tmp/safeflow-sandbox-test/.safeflow/memory.db ".schema memory"
# Должны видеться новые колонки
ls /tmp/safeflow-sandbox-test/.safeflow/backups/
# Должен быть .bak файл
```

Если миграция падает — стоп, докладывай.

---

## Финальный push и PR

```bash
git push -u origin feat/v2-hybrid-memory
# Открой PR через gh CLI или дай мне URL для ручного открытия
gh pr create --title "SafeFlo v2.0: hybrid memory with agent lifecycle" \
  --body "См. docs/SAFEFLOW-V2-TASK.md. Бенчмарк-результаты в benchmark-results/."
```

**Не мержь PR** — это за пользователем.

---

## Финальный отчёт

В конце выведи в чат:

```markdown
## SafeFlo v2.0 — отчёт о реализации

### Бенчмарк (главное)
| Тип запроса | v1 recall@5 | v2 recall@5 | Δ |
|---|---|---|---|
| lexical | X.XX | X.XX | +X.X п.п. |
| synonym | X.XX | X.XX | +X.X п.п. |
| concept | X.XX | X.XX | +X.X п.п. |

### Что сделано
- Migration framework: ...
- Hybrid search: ...
- Memory lifecycle: ...
- Consolidation: ...
- Бенчмарк: ...
- Документация: ...

### Что пошло не по плану
- ... (если ничего — так и пиши)

### Что я НЕ сделал, оставил на потом
- ...

### Тесты
- npm test: passed/failed
- npm run lint: passed/failed
- migration sandbox test: passed/failed

### PR
- URL: ...
- Коммитов: N
- Ветка: feat/v2-hybrid-memory

### Готово к ревью и мержу.
```

---

## Чего НЕ делаем в v2.0

- Reinforcement learning для importance на основе сигналов успешности
- Knowledge graph между записями
- Multi-modal memory (изображения, файлы)
- Cross-namespace queries
- Compression strategies при достижении лимита размера

Это задел на v3.0.
