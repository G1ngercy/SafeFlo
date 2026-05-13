/**
 * Защита от path traversal атак.
 *
 * Известные уязвимости ruflo: фильтр пропускал `....//` и подобные конструкции.
 * Здесь мы используем `path.resolve` + проверку префикса вместо строкового
 * парсинга — это устойчивее к обходам через двойные слэши, символьные
 * кодировки, юникод и `..`-последовательности.
 */

import path from "node:path";
import fs from "node:fs";

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

/**
 * Проверяет, что `targetPath` находится внутри `rootDir` после полного
 * разрешения. Возвращает абсолютный безопасный путь или бросает ошибку.
 *
 * Ключевые проверки:
 *   1. `path.resolve` нормализует `..`, `.`, двойные слэши.
 *   2. Сравнение через `path.relative` + проверка отсутствия `..` —
 *      устойчивее, чем `startsWith`, потому что `startsWith` ломается на
 *      случаях вроде `/home/user` vs `/home/userBAD`.
 *   3. Запрет символических ссылок, ведущих наружу (через `realpath`).
 *   4. Запрет null-байтов в путях.
 */
export function safeResolve(rootDir: string, targetPath: string): string {
  if (typeof targetPath !== "string") {
    throw new PathSecurityError("Путь должен быть строкой");
  }

  if (targetPath.includes("\0")) {
    throw new PathSecurityError("Null-байт в пути запрещён");
  }

  // Запрещаем абсолютные пути на входе — клиент должен передавать
  // относительные пути от корня проекта.
  if (path.isAbsolute(targetPath)) {
    throw new PathSecurityError(
      `Абсолютные пути запрещены: ${targetPath}`,
    );
  }

  const absoluteRoot = path.resolve(rootDir);
  const resolved = path.resolve(absoluteRoot, targetPath);

  // Проверяем, что resolved действительно внутри absoluteRoot.
  // Используем path.relative: если результат начинается с ".." или сам по
  // себе абсолютный — значит resolved лежит вне корня. Пустая строка значит
  // resolved == absoluteRoot, что мы разрешаем.
  const relative = path.relative(absoluteRoot, resolved);

  if (relative === "..") {
    throw new PathSecurityError(
      `Путь выходит за пределы корневой директории: ${targetPath}`,
    );
  }
  if (relative.startsWith(".." + path.sep)) {
    throw new PathSecurityError(
      `Путь выходит за пределы корневой директории: ${targetPath}`,
    );
  }
  if (path.isAbsolute(relative)) {
    throw new PathSecurityError(
      `Путь выходит за пределы корневой директории: ${targetPath}`,
    );
  }

  // Дополнительная проверка через realpath для защиты от symlink-атак.
  // Если файл существует — проверяем реальный путь.
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realRoot = fs.realpathSync(absoluteRoot);
      const realRelative = path.relative(realRoot, realPath);
      if (
        realRelative.startsWith("..") ||
        path.isAbsolute(realRelative)
      ) {
        throw new PathSecurityError(
          `Символическая ссылка ведёт за пределы корня: ${targetPath}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof PathSecurityError) throw err;
    // ENOENT — нормально, файла ещё нет.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return resolved;
}

/**
 * Проверяет имя файла на безопасность (без путей, без спецсимволов).
 * Используется для имён, которые потом склеиваются с базовой директорией.
 */
export function safeFilename(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new PathSecurityError("Имя файла должно быть непустой строкой");
  }
  if (name.length > 255) {
    throw new PathSecurityError("Имя файла слишком длинное");
  }
  if (name.includes("\0") || name.includes("/") || name.includes("\\")) {
    throw new PathSecurityError(
      `Имя файла содержит запрещённые символы: ${name}`,
    );
  }
  if (name === "." || name === "..") {
    throw new PathSecurityError(`Запрещённое имя файла: ${name}`);
  }
  // Запрещаем имена с управляющими символами.
  if (/[\x00-\x1f]/.test(name)) {
    throw new PathSecurityError(
      "Имя файла содержит управляющие символы",
    );
  }
  return name;
}
