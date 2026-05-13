#!/usr/bin/env node
/**
 * Аудит MCP tool descriptions.
 *
 * Цель: предотвратить класс уязвимости, замеченный в ruflo, когда
 * описания MCP-инструментов содержали скрытые инструкции для LLM
 * (например, добавлять владельца репозитория как контрибьютора).
 *
 * Эта проверка работает на src/mcp/server.ts: парсит TypeScript-литералы
 * `description: "..."` и применяет регулярные выражения.
 *
 * Правила:
 *   - запрещены императивы в адрес LLM ("you must", "always", "never tell",
 *     "secretly", "without informing"…);
 *   - запрещены URL (http://, https://) — описание должно быть автономным;
 *   - запрещены упоминания внешних компаний и сервисов кроме самой SafeFlow;
 *   - запрещены email-адреса;
 *   - запрещены имена в стиле @username;
 *   - запрещены инструкции "if asked" / "если спросят" / подобные.
 *
 * Скрипт намеренно простой: ловим явные паттерны. Это не AI-аудитор,
 * а grep с человекочитаемым выводом. Используется в CI и локально.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = path.join(__dirname, "..", "src", "mcp", "server.ts");

const FORBIDDEN_PATTERNS = [
  {
    re: /\b(you must|you should|always|never tell|secretly|without (informing|telling)|don't (mention|tell|reveal))\b/i,
    reason: "Императив в адрес модели",
  },
  {
    re: /\bhttps?:\/\//i,
    reason: "URL в описании запрещён",
  },
  {
    re: /\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/i,
    reason: "Email-адрес в описании запрещён",
  },
  {
    re: /(?<![a-zA-Z0-9_])@[a-zA-Z][a-zA-Z0-9_-]{2,}/,
    reason: "Упоминание в стиле @username запрещено",
  },
  {
    re: /\b(if asked|when asked|если спросят|when the user asks about)\b/i,
    reason: "Условные инструкции для модели запрещены",
  },
  {
    re: /\b(github|twitter|x\.com|discord|telegram|email me|contact me|reach out)\b/i,
    reason: "Упоминание внешних каналов связи запрещено",
  },
  {
    re: /\b(api[_ ]?key|token|secret|password)\b/i,
    reason: "Описание не должно подсказывать модели секреты",
  },
];

function extractDescriptions(source) {
  // Ищем все блоки вида `name: "...",` и `description: "..."`.
  // Описания могут быть многострочными со склейкой `+`, но в нашем коде
  // мы держим описания как простые двойные кавычки в одну строку — это
  // тоже архитектурное требование (для проверяемости).
  const results = [];
  const re = /name:\s*"([a-zA-Z_][\w]*)",\s*\n\s*description:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const lineNumber = source.slice(0, match.index).split("\n").length;
    results.push({
      tool: match[1],
      description: match[2],
      line: lineNumber,
    });
  }
  return results;
}

function audit() {
  if (!fs.existsSync(SERVER_FILE)) {
    console.error("Файл не найден:", SERVER_FILE);
    process.exit(1);
  }
  const source = fs.readFileSync(SERVER_FILE, "utf-8");
  const descriptions = extractDescriptions(source);

  if (descriptions.length === 0) {
    console.error(
      "Не найдено ни одного описания инструмента. Проверь регулярное выражение или формат файла.",
    );
    process.exit(1);
  }

  console.log(`Найдено описаний: ${descriptions.length}`);

  let problems = 0;

  for (const { tool, description, line } of descriptions) {
    for (const { re, reason } of FORBIDDEN_PATTERNS) {
      const m = description.match(re);
      if (m) {
        console.error(
          `\n  ❌ ${SERVER_FILE}:${line}\n     tool: ${tool}\n     причина: ${reason}\n     совпадение: ${JSON.stringify(m[0])}\n     описание: ${JSON.stringify(description)}`,
        );
        problems++;
      }
    }
    // Длина описания: слишком длинное описание = подозрительно
    // (может скрывать инструкции в "шуме").
    if (description.length > 600) {
      console.error(
        `\n  ❌ ${SERVER_FILE}:${line}\n     tool: ${tool}\n     причина: описание слишком длинное (${description.length} символов; лимит 600)`,
      );
      problems++;
    }
  }

  if (problems > 0) {
    console.error(`\nАудит провален: ${problems} нарушений.`);
    process.exit(1);
  }

  console.log("✓ Аудит MCP описаний пройден: нарушений не найдено.");
}

audit();
