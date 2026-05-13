#!/usr/bin/env node
/**
 * Объединённый аудит: запускает все security-проверки, которые делает CI,
 * локально и в одном выводе. Удобно прогонять перед PR или релизом.
 *
 * Выход 0 — все проверки пройдены.
 * Выход 1 — хотя бы одна проверка провалена.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let failed = 0;

function check(name, fn) {
  process.stdout.write(`[ ] ${name}... `);
  try {
    fn();
    process.stdout.write("\r[✓] " + name + "\n");
  } catch (err) {
    process.stdout.write("\r[✗] " + name + "\n");
    console.error("    " + (err.message || err));
    failed++;
  }
}

check("package.json не содержит install-скриптов", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const forbidden = [
    "preinstall",
    "install",
    "postinstall",
    "preuninstall",
    "postuninstall",
  ];
  const found = forbidden.filter((k) => pkg.scripts && pkg.scripts[k]);
  if (found.length) throw new Error("Найдены: " + found.join(", "));
});

check("все версии зависимостей зафиксированы", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  const loose = Object.entries(allDeps).filter(([_, v]) => /^[\^~]/.test(v));
  if (loose.length) {
    throw new Error(
      "Незафиксированные версии: " + loose.map(([k, v]) => `${k}@${v}`).join(", "),
    );
  }
});

check("нет опасных API в src/ (eval, Function, exec)", () => {
  try {
    const out = execSync(
      String.raw`grep -rn --include='*.ts' -E '\beval\(|new Function\(|child_process\.exec\(' src/`,
      { cwd: ROOT, encoding: "utf-8" },
    );
    if (out.trim()) throw new Error("Найдено:\n" + out);
  } catch (err) {
    // grep exit code 1 = ничего не найдено = OK
    if (err.status === 1) return;
    throw err;
  }
});

check("нет сетевых вызовов в src/", () => {
  try {
    const out = execSync(
      String.raw`grep -rn --include='*.ts' -E '\bfetch\(|http\.request|https\.request|net\.connect' src/`,
      { cwd: ROOT, encoding: "utf-8" },
    );
    if (out.trim()) throw new Error("Найдено:\n" + out);
  } catch (err) {
    if (err.status === 1) return;
    throw err;
  }
});

check("нет ссылок на домашнюю директорию в src/", () => {
  try {
    const out = execSync(
      String.raw`grep -rn --include='*.ts' -E 'os\.homedir|process\.env\.HOME' src/`,
      { cwd: ROOT, encoding: "utf-8" },
    );
    if (out.trim()) throw new Error("Найдено:\n" + out);
  } catch (err) {
    if (err.status === 1) return;
    throw err;
  }
});

check("MCP descriptions проходят аудит", () => {
  execSync("node scripts/audit-mcp-descriptions.mjs", {
    cwd: ROOT,
    stdio: "pipe",
  });
});

check("TypeScript строгая проверка типов", () => {
  execSync("npx tsc --noEmit", { cwd: ROOT, stdio: "pipe" });
});

console.log("");
if (failed > 0) {
  console.error(`Аудит провален: ${failed} проверка(и) не прошли.`);
  process.exit(1);
}
console.log("✓ Все проверки пройдены.");
