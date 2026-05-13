/**
 * Audit log. Каждое существенное действие — запись в локальный
 * append-only JSONL-файл с timestamp, источником и payload.
 *
 * Это противоположность модели ruflo, где действия агентов происходили
 * без следов (фоновые процессы, скрытые правки в ~/.claude и т.д.).
 *
 * Гарантии:
 *   - Только append (никаких update/delete на уровне API).
 *   - Запись синхронна с действием — если запись упала, действие не выполняется.
 *   - Размер файла ограничен; при превышении — ротация.
 *   - Никакой сетевой передачи: лог всегда локальный.
 */

import fs from "node:fs";
import path from "node:path";
import { safeResolve } from "../security/paths.js";

export interface AuditEvent {
  timestamp: string;
  source: string;
  action: string;
  payload?: Record<string, unknown>;
  /** Тонкий разделитель: успех, отказ, ошибка. */
  outcome: "ok" | "denied" | "error";
  reason?: string;
}

const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_PAYLOAD_SIZE = 16 * 1024; // 16 KB на одно событие

export class AuditLogger {
  private readonly logPath: string;

  constructor(projectRoot: string) {
    const auditDir = safeResolve(projectRoot, ".safeflow");
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    }
    this.logPath = path.join(auditDir, "audit.jsonl");
  }

  log(event: Omit<AuditEvent, "timestamp">): void {
    const full: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Усечение слишком больших payload — чтобы один агент не мог раздуть лог.
    const serialized = JSON.stringify(full);
    if (serialized.length > MAX_PAYLOAD_SIZE) {
      const truncated: AuditEvent = {
        timestamp: full.timestamp,
        source: full.source,
        action: full.action,
        outcome: full.outcome,
        reason: "payload truncated due to size",
      };
      fs.appendFileSync(this.logPath, JSON.stringify(truncated) + "\n", {
        mode: 0o600,
      });
    } else {
      fs.appendFileSync(this.logPath, serialized + "\n", { mode: 0o600 });
    }

    this.rotateIfNeeded();
  }

  private rotateIfNeeded(): void {
    try {
      const stats = fs.statSync(this.logPath);
      if (stats.size > MAX_LOG_SIZE) {
        const archivePath = this.logPath + "." + Date.now() + ".old";
        fs.renameSync(this.logPath, archivePath);
      }
    } catch {
      // если файла нет — ничего страшного
    }
  }

  /**
   * Чтение последних N событий — для отладки и UI.
   */
  tail(n: number): AuditEvent[] {
    if (!fs.existsSync(this.logPath)) return [];
    const raw = fs.readFileSync(this.logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const last = lines.slice(-n);
    const events: AuditEvent[] = [];
    for (const line of last) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // пропускаем повреждённые строки
      }
    }
    return events;
  }
}
