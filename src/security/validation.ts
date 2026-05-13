/**
 * Валидация и безопасное обращение с данными.
 *
 * Покрывает:
 *   - Защиту от prototype pollution (известная проблема ruflo): запрещаем
 *     ключи `__proto__`, `constructor`, `prototype` в любых пользовательских
 *     объектах, которые мы парсим или мержим.
 *   - Безопасное использование SQL: вся работа с БД идёт ТОЛЬКО через
 *     параметризованные запросы better-sqlite3 (`.prepare(...).run(...)` с
 *     именованными параметрами). Здесь — валидаторы для идентификаторов,
 *     которые нельзя параметризовать (имена таблиц, namespace).
 *   - Ограничения на размер строк и глубину объектов — против DoS через
 *     раздутые payload-ы.
 */

import { z } from "zod";

const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Безопасный JSON-парс с защитой от prototype pollution.
 * Использует reviver, который отбрасывает опасные ключи.
 */
export function safeJsonParse(input: string): unknown {
  if (input.length > 1_000_000) {
    throw new ValidationError("JSON слишком большой (>1MB)");
  }
  return JSON.parse(input, (key, value) => {
    if (DANGEROUS_KEYS.has(key)) {
      return undefined;
    }
    return value;
  });
}

/**
 * Рекурсивная проверка объекта на опасные ключи и чрезмерную глубину.
 * Бросает ValidationError при нарушении.
 */
export function assertSafeObject(
  obj: unknown,
  maxDepth = 16,
  depth = 0,
): void {
  if (depth > maxDepth) {
    throw new ValidationError("Объект слишком глубокий");
  }
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    if (obj.length > 10_000) {
      throw new ValidationError("Массив слишком большой");
    }
    for (const item of obj) {
      assertSafeObject(item, maxDepth, depth + 1);
    }
    return;
  }
  // Используем Object.keys, чтобы получить только собственные перечисляемые
  // свойства — но это не защищает от ключей, заданных через Object.defineProperty.
  // Поэтому дополнительно проверяем getOwnPropertyNames.
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new ValidationError(`Запрещённый ключ: ${key}`);
    }
    assertSafeObject(
      (obj as Record<string, unknown>)[key],
      maxDepth,
      depth + 1,
    );
  }
}

/**
 * Валидатор для идентификаторов, которые попадают в SQL как часть имени
 * (таблица, namespace). Параметризованные запросы их не защищают, поэтому
 * мы разрешаем только узкий алфавит.
 */
export const SqlIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Допустимы только буквы, цифры и _");

/**
 * Валидатор для namespace памяти — пользовательский ключ верхнего уровня.
 * Разрешаем буквы, цифры, дефис, подчёркивание, точку.
 */
export const MemoryNamespace = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._\-]+$/, "Допустимы a-z, 0-9, _, -, .");

/**
 * Универсальный валидатор для ключей памяти.
 */
export const MemoryKey = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._\-:/]+$/, "Допустимы a-z, 0-9, _, -, ., :, /");

/**
 * Контентная строка с лимитом на размер.
 */
export const ContentString = z.string().max(100_000);

/**
 * ID агента — UUID-подобный, генерируется сервером, но валидируется при чтении.
 */
export const AgentId = z
  .string()
  .regex(/^agent_[a-f0-9]{16}$/, "Невалидный agent ID");
