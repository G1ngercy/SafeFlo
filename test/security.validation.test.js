/**
 * Тесты валидации — особенно защиты от prototype pollution
 * и валидации SQL-идентификаторов.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  safeJsonParse,
  assertSafeObject,
  ValidationError,
} from "../dist/security/validation.js";

test("safeJsonParse: парсит нормальный JSON", () => {
  const r = safeJsonParse('{"a": 1, "b": [2, 3]}');
  assert.deepEqual(r, { a: 1, b: [2, 3] });
});

test("safeJsonParse: вырезает __proto__", () => {
  const r = safeJsonParse('{"__proto__": {"polluted": true}, "ok": 1}');
  assert.deepEqual(r, { ok: 1 });
  // Глобальный Object.prototype не отравлен.
  assert.equal(({}).polluted, undefined);
});

test("safeJsonParse: вырезает constructor.prototype.X", () => {
  const r = safeJsonParse(
    '{"constructor": {"prototype": {"x": 1}}, "ok": 1}',
  );
  // constructor должен быть вырезан reviver-ом.
  // У обычного {} есть унаследованный constructor === Object,
  // но не как own property. Проверяем именно отсутствие own property.
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "constructor"));
});

test("safeJsonParse: отклоняет слишком большой вход", () => {
  const big = "x".repeat(1_000_001);
  assert.throws(() => safeJsonParse(big), ValidationError);
});

test("assertSafeObject: пропускает безобидное", () => {
  assertSafeObject({ a: 1, b: { c: [1, 2, 3] } });
});

test("assertSafeObject: блокирует __proto__ как own property", () => {
  const obj = Object.create(null);
  Object.defineProperty(obj, "__proto__", {
    value: { x: 1 },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.throws(() => assertSafeObject(obj), ValidationError);
});

test("assertSafeObject: блокирует чрезмерную глубину", () => {
  const deep = {};
  let cur = deep;
  for (let i = 0; i < 100; i++) {
    const next = {};
    cur.next = next;
    cur = next;
  }
  assert.throws(() => assertSafeObject(deep, 16), ValidationError);
});

test("assertSafeObject: блокирует огромные массивы", () => {
  const big = new Array(20_000).fill(1);
  assert.throws(() => assertSafeObject(big), ValidationError);
});
