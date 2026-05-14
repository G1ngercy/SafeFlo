/**
 * CLI для SafeFlo.
 *
 * Команды:
 *   - `init`        — создаёт `.safeflow/` в текущей директории и пример конфига.
 *                     НЕ модифицирует никакие файлы вне текущей директории.
 *                     НЕ модифицирует ~/.claude/CLAUDE.md и подобные глобальные файлы.
 *   - `uninstall`   — удаляет ВСЕ артефакты SafeFlo из проекта (`.safeflow/`,
 *                     `.claude/commands/safeflow-*`). Никаких хвостов.
 *   - `status`      — показывает состояние локальных БД и аудит-лога.
 *   - `mcp`         — запускает MCP-сервер (используется через Claude Code).
 *
 * Что CLI принципиально НЕ делает:
 *   - не делает сетевых вызовов;
 *   - не запускает фоновые процессы;
 *   - не вызывает eval/exec на пользовательских данных;
 *   - не модифицирует ничего за пределами текущей проектной директории.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { AuditLogger } from "./audit/logger.js";

const SAFEFLOW_DIR = ".safeflow";
const CLAUDE_LOCAL_DIR = ".claude";
const SAFEFLOW_FILES_IN_CLAUDE = [
  "commands/safeflow-plan.md",
  "commands/safeflow-memory.md",
  "commands/safeflow-agents.md",
];

function projectRoot(): string {
  return process.cwd();
}

function cmdInit(): void {
  const root = projectRoot();
  const safeflowDir = path.join(root, SAFEFLOW_DIR);
  if (fs.existsSync(safeflowDir)) {
    console.log(`SafeFlo уже инициализирован в ${root}`);
    console.log("Содержимое:");
    for (const f of fs.readdirSync(safeflowDir)) {
      console.log("  ." + path.sep + path.join(SAFEFLOW_DIR, f));
    }
    return;
  }
  fs.mkdirSync(safeflowDir, { recursive: true, mode: 0o700 });

  // Пишем README прямо в .safeflow/, чтобы было понятно, что это и как удалить.
  fs.writeFileSync(
    path.join(safeflowDir, "README.txt"),
    [
      "Эта директория создана SafeFlo.",
      "Все данные SafeFlo (память, планы, агенты, аудит-лог) хранятся здесь.",
      "",
      "Чтобы полностью удалить SafeFlo из проекта:",
      "  npx safeflow uninstall",
      "",
      "Или вручную:",
      "  rm -rf .safeflow",
      "  rm -rf .claude/commands/safeflow-*",
      "",
      "SafeFlo не модифицирует никаких файлов вне директории проекта.",
    ].join("\n"),
    { mode: 0o600 },
  );

  // Создаём slash-команды для Claude Code — но ТОЛЬКО локально, в .claude
  // текущего проекта. Не трогаем ~/.claude/.
  const claudeDir = path.join(root, CLAUDE_LOCAL_DIR, "commands");
  fs.mkdirSync(claudeDir, { recursive: true });
  for (const [name, content] of Object.entries(slashCommandFiles())) {
    fs.writeFileSync(path.join(root, CLAUDE_LOCAL_DIR, name), content);
  }

  const audit = new AuditLogger(root);
  audit.log({
    source: "cli",
    action: "init",
    payload: { root },
    outcome: "ok",
  });

  console.log("SafeFlo инициализирован.");
  console.log("");
  console.log("Что создано:");
  console.log(`  ${SAFEFLOW_DIR}/                  — данные (SQLite, audit)`);
  console.log(`  ${CLAUDE_LOCAL_DIR}/commands/safeflow-*  — slash-команды для Claude Code`);
  console.log("");
  console.log("Чтобы подключить MCP-сервер к Claude Code:");
  console.log(`  claude mcp add safeflow -- node ${path.resolve("./dist/mcp/server.js")}`);
  console.log("");
  console.log("Чтобы полностью удалить: npx safeflow uninstall");
}

function cmdUninstall(force = false): void {
  const root = projectRoot();
  const safeflowDir = path.join(root, SAFEFLOW_DIR);
  const claudeDir = path.join(root, CLAUDE_LOCAL_DIR);

  // Показываем, что будет удалено.
  const toRemove: string[] = [];
  if (fs.existsSync(safeflowDir)) toRemove.push(safeflowDir);
  for (const f of SAFEFLOW_FILES_IN_CLAUDE) {
    const p = path.join(claudeDir, f);
    if (fs.existsSync(p)) toRemove.push(p);
  }

  if (toRemove.length === 0) {
    console.log("SafeFlo артефактов не найдено. Нечего удалять.");
    return;
  }

  console.log("Будет удалено:");
  for (const p of toRemove) console.log("  " + path.relative(root, p));

  if (!force) {
    console.log("");
    console.log("Чтобы подтвердить, запустите: npx safeflow uninstall --yes");
    return;
  }

  for (const p of toRemove) {
    if (fs.statSync(p).isDirectory()) {
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      fs.unlinkSync(p);
    }
  }
  console.log("SafeFlo полностью удалён из проекта.");
  console.log(
    "SafeFlo не использует глобальных путей; никаких файлов вне проекта не было.",
  );
}

function cmdStatus(): void {
  const root = projectRoot();
  const safeflowDir = path.join(root, SAFEFLOW_DIR);
  if (!fs.existsSync(safeflowDir)) {
    console.log("SafeFlo не инициализирован. Запустите: npx safeflow init");
    return;
  }
  console.log(`Проект: ${root}`);
  console.log(`SafeFlo директория: ${safeflowDir}`);
  console.log("");
  console.log("Файлы:");
  for (const f of fs.readdirSync(safeflowDir)) {
    const full = path.join(safeflowDir, f);
    const stat = fs.statSync(full);
    console.log(
      `  ${f.padEnd(20)} ${(stat.size / 1024).toFixed(1).padStart(8)} KB`,
    );
  }
}

function cmdMcp(): void {
  // Запускаем dist/mcp/server.js как дочерний процесс с тем же stdio,
  // чтобы Claude Code мог общаться по stdio.
  const serverPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "mcp",
    "server.js",
  );
  const child = spawn(process.execPath, [serverPath], {
    stdio: "inherit",
    env: { ...process.env, SAFEFLOW_PROJECT_ROOT: process.cwd() },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function slashCommandFiles(): Record<string, string> {
  return {
    "commands/safeflow-plan.md": [
      "# /safeflow-plan",
      "",
      "Создать или обновить план задачи, используя MCP-инструменты SafeFlo.",
      "",
      "## Использование",
      "",
      "1. Вызови `plan_create` с описанием цели.",
      "2. Декомпозируй цель на 3–7 шагов и добавь каждый через `plan_add_step`,",
      "   указывая зависимости между шагами при необходимости.",
      "3. Покажи получившийся план пользователю.",
      "",
      "Все данные хранятся локально в `.safeflow/plans.db`.",
      "",
    ].join("\n"),
    "commands/safeflow-memory.md": [
      "# /safeflow-memory",
      "",
      "Работа с локальной памятью проекта через MCP-инструменты SafeFlo.",
      "",
      "## Доступные операции",
      "",
      "- `memory_store` — сохранить значение",
      "- `memory_get`   — получить по namespace+key",
      "- `memory_search` — полнотекстовый поиск (FTS5)",
      "- `memory_list`  — список ключей в namespace",
      "- `memory_delete` — удалить ключ",
      "",
      "Все данные хранятся локально в `.safeflow/memory.db`. Никаких сетевых вызовов.",
      "",
    ].join("\n"),
    "commands/safeflow-agents.md": [
      "# /safeflow-agents",
      "",
      "Координация подзадач через логических агентов SafeFlo.",
      "",
      "## Использование",
      "",
      "1. Вызови `agent_register` с ролью (researcher, coder, reviewer, …).",
      "2. Используй полученный `namespace` для сохранения данных агента в памяти.",
      "3. По окончании работы переведи агента в `terminated` через `agent_update_status`.",
      "",
      "Координатор НЕ запускает фоновые процессы. Все агенты — логические сущности",
      "в одной БД, что обеспечивает прозрачность и аудит.",
      "",
    ].join("\n"),
  };
}

function help(): void {
  console.log("SafeFlo — безопасная локальная платформа оркестрации агентов.");
  console.log("");
  console.log("Использование: safeflow <команда> [опции]");
  console.log("");
  console.log("Команды:");
  console.log("  init           инициализировать SafeFlo в текущем проекте");
  console.log("  status         показать состояние локальных данных");
  console.log("  mcp            запустить MCP-сервер (stdio)");
  console.log("  uninstall      удалить все артефакты SafeFlo из проекта");
  console.log("    --yes        подтвердить удаление");
  console.log("  help           показать эту справку");
  console.log("");
  console.log(
    "SafeFlo никогда не модифицирует файлы вне директории текущего проекта.",
  );
}

const cmd = process.argv[2] ?? "help";
const args = process.argv.slice(3);

switch (cmd) {
  case "init":
    cmdInit();
    break;
  case "status":
    cmdStatus();
    break;
  case "mcp":
    cmdMcp();
    break;
  case "uninstall":
    cmdUninstall(args.includes("--yes") || args.includes("-y"));
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`Неизвестная команда: ${cmd}`);
    help();
    process.exit(1);
}
