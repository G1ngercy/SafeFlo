/**
 * Эвристика стартовой важности записи памяти.
 *
 * Важность — число [0, 1], влияющее на ранжирование в recall(). Здесь только
 * детерминированный дефолт; никакого ML, никаких сетевых вызовов. Пользователь
 * может переопределить importance явно при store().
 */

export type MemoryType = "episodic" | "semantic" | "procedural";

const SEMANTIC_BOOST = 0.15;
const PROCEDURAL_BOOST = 0.2;
const KEYWORD_BOOST = 0.1;
const LONG_CONTENT_BOOST = 0.05;
const SHORT_CONTENT_PENALTY = 0.05;
const LONG_CONTENT_CHARS = 500;
const SHORT_CONTENT_CHARS = 50;

// Маркеры решений/обязательств на русском и английском — такие записи обычно
// важнее проходных заметок.
const KEYWORDS =
  /реши(ли|л)|договорились|важно|критично|обязательно|никогда|всегда|decided|agreed|important|critical|must|never|always|TODO|FIXME/i;

export function defaultImportance(content: string, type: MemoryType): number {
  let score = 0.5;
  if (type === "semantic") score += SEMANTIC_BOOST;
  if (type === "procedural") score += PROCEDURAL_BOOST;
  if (KEYWORDS.test(content)) score += KEYWORD_BOOST;
  if (content.length > LONG_CONTENT_CHARS) score += LONG_CONTENT_BOOST;
  if (content.length < SHORT_CONTENT_CHARS) score -= SHORT_CONTENT_PENALTY;
  return Math.max(0, Math.min(1, score));
}
