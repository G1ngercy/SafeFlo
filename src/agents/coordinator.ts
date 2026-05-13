/**
 * Agent coordinator.
 *
 * Упрощённый аналог "swarm" из ruflo. Вместо запуска фоновых процессов и
 * многомашинной федерации мы предоставляем структуру для координации
 * нескольких логических агентов, которые работают в рамках одного клиента
 * (например, Claude Code порождает подзадачи через свой инструмент Task).
 *
 * Что делает координатор:
 *   - регистрирует агентов с уникальным ID и роль (researcher, coder, reviewer);
 *   - выдаёт каждому изолированный memory namespace;
 *   - отслеживает их статус (active, idle, terminated);
 *   - все действия — в audit log.
 *
 * Чего координатор НЕ делает:
 *   - не запускает фоновые процессы;
 *   - не открывает сетевые порты;
 *   - не модифицирует ничего за пределами `.safeflow/`;
 *   - не "федерируется" с удалёнными машинами.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { safeResolve } from "../security/paths.js";
import { AuditLogger } from "../audit/logger.js";

export type AgentStatus = "active" | "idle" | "terminated";

const ALLOWED_AGENT_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  active: ["idle", "terminated"],
  idle: ["active", "terminated"],
  terminated: [],
};

const AgentRole = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_\-]*$/, "Роль: буквы, цифры, _, -");

export interface Agent {
  id: string;
  role: string;
  namespace: string;
  status: AgentStatus;
  task: string | null;
  createdAt: string;
  updatedAt: string;
}

export class AgentCoordinator {
  private readonly db: Database.Database;
  private readonly audit: AuditLogger;

  constructor(projectRoot: string, audit: AuditLogger) {
    const dir = safeResolve(projectRoot, ".safeflow");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path.join(dir, "agents.db"));
    this.db.pragma("journal_mode = WAL");
    this.audit = audit;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        namespace TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        task TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
    `);
  }

  /**
   * Регистрирует нового агента. ID и namespace генерируются сервером.
   */
  register(role: string, initialTask: string | null = null): Agent {
    const r = AgentRole.parse(role);
    const id = "agent_" + crypto.randomBytes(8).toString("hex");
    const namespace = `agents.${r}.${id}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO agents (id, role, namespace, status, task, created_at, updated_at)
         VALUES (@id, @role, @ns, 'active', @task, @now, @now)`,
      )
      .run({ id, role: r, ns: namespace, task: initialTask, now });

    this.audit.log({
      source: "coordinator",
      action: "register",
      payload: { agentId: id, role: r, namespace },
      outcome: "ok",
    });

    return {
      id,
      role: r,
      namespace,
      status: "active",
      task: initialTask,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateStatus(agentId: string, newStatus: AgentStatus): Agent {
    const row = this.db
      .prepare(
        `SELECT id, role, namespace, status, task, created_at FROM agents WHERE id = @id`,
      )
      .get({ id: agentId }) as
      | {
          id: string;
          role: string;
          namespace: string;
          status: AgentStatus;
          task: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) throw new Error(`Агент не найден: ${agentId}`);

    if (!ALLOWED_AGENT_TRANSITIONS[row.status].includes(newStatus)) {
      this.audit.log({
        source: "coordinator",
        action: "update_status",
        payload: { agentId, from: row.status, to: newStatus },
        outcome: "denied",
        reason: "недопустимый переход статуса",
      });
      throw new Error(
        `Недопустимый переход статуса агента: ${row.status} → ${newStatus}`,
      );
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agents SET status = @s, updated_at = @now WHERE id = @id`,
      )
      .run({ s: newStatus, now, id: agentId });

    this.audit.log({
      source: "coordinator",
      action: "update_status",
      payload: { agentId, from: row.status, to: newStatus },
      outcome: "ok",
    });

    return {
      id: row.id,
      role: row.role,
      namespace: row.namespace,
      status: newStatus,
      task: row.task,
      createdAt: row.created_at,
      updatedAt: now,
    };
  }

  list(filterStatus?: AgentStatus): Agent[] {
    const rows = filterStatus
      ? (this.db
          .prepare(
            `SELECT id, role, namespace, status, task, created_at, updated_at
             FROM agents WHERE status = @s ORDER BY created_at DESC`,
          )
          .all({ s: filterStatus }) as Array<{
          id: string;
          role: string;
          namespace: string;
          status: AgentStatus;
          task: string | null;
          created_at: string;
          updated_at: string;
        }>)
      : (this.db
          .prepare(
            `SELECT id, role, namespace, status, task, created_at, updated_at
             FROM agents ORDER BY created_at DESC`,
          )
          .all() as Array<{
          id: string;
          role: string;
          namespace: string;
          status: AgentStatus;
          task: string | null;
          created_at: string;
          updated_at: string;
        }>);

    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      namespace: r.namespace,
      status: r.status,
      task: r.task,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  get(agentId: string): Agent | null {
    const row = this.db
      .prepare(
        `SELECT id, role, namespace, status, task, created_at, updated_at
         FROM agents WHERE id = @id`,
      )
      .get({ id: agentId }) as
      | {
          id: string;
          role: string;
          namespace: string;
          status: AgentStatus;
          task: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      role: row.role,
      namespace: row.namespace,
      status: row.status,
      task: row.task,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
