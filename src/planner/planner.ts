/**
 * Task planner.
 *
 * Принимает цель на естественном языке и предлагает декомпозицию на шаги.
 *
 * В отличие от ruflo, где планировщик обращается к удалённому сервису
 * `goal.ruv.io`, тут вся логика локальная. Мы НЕ делаем LLM-вызовы сами —
 * мы лишь структурируем задачу в формат, который потом Claude (через MCP)
 * заполняет и исполняет. Это самое честное разделение: библиотека
 * предоставляет structure, модель — intelligence.
 *
 * Поддерживаются:
 *   - создание плана из текстового описания цели
 *   - добавление/обновление шагов
 *   - переходы статусов с проверкой допустимости
 *   - сохранение в SQLite, прозрачное для аудита
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { safeResolve } from "../security/paths.js";
import { ContentString, assertSafeObject } from "../security/validation.js";
import { AuditLogger } from "../audit/logger.js";

export type StepStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "done"
  | "failed";

export interface PlanStep {
  id: string;
  planId: string;
  ordinal: number;
  title: string;
  description: string;
  status: StepStatus;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  goal: string;
  status: "active" | "completed" | "abandoned";
  createdAt: string;
  updatedAt: string;
  steps: PlanStep[];
}

const ALLOWED_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["in_progress", "blocked", "failed"],
  in_progress: ["done", "blocked", "failed"],
  blocked: ["pending", "in_progress", "failed"],
  done: [],
  failed: ["pending"],
};

const StepInput = z.object({
  title: ContentString.refine((s) => s.length > 0 && s.length <= 500),
  description: ContentString,
  dependsOn: z.array(z.string()).max(50).default([]),
});

export class TaskPlanner {
  private readonly db: Database.Database;
  private readonly audit: AuditLogger;

  constructor(projectRoot: string, audit: AuditLogger) {
    const dir = safeResolve(projectRoot, ".safeflow");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path.join(dir, "plans.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.audit = audit;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plan_steps (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        depends_on TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_steps_plan ON plan_steps(plan_id);
      CREATE INDEX IF NOT EXISTS idx_steps_status ON plan_steps(status);
    `);
  }

  private generateId(prefix: string): string {
    return prefix + "_" + crypto.randomBytes(8).toString("hex");
  }

  /**
   * Создаёт пустой план. Шаги добавляются отдельно — это даёт прозрачность:
   * клиент (Claude) сам решает, как декомпозировать, и каждый шаг виден в аудите.
   */
  createPlan(goal: string): Plan {
    const g = ContentString.parse(goal);
    if (g.length === 0) throw new Error("Цель не может быть пустой");

    const id = this.generateId("plan");
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO plans (id, goal, status, created_at, updated_at)
         VALUES (@id, @goal, 'active', @now, @now)`,
      )
      .run({ id, goal: g, now });

    this.audit.log({
      source: "planner",
      action: "create_plan",
      payload: { planId: id, goal: g.slice(0, 200) },
      outcome: "ok",
    });

    return {
      id,
      goal: g,
      status: "active",
      createdAt: now,
      updatedAt: now,
      steps: [],
    };
  }

  addStep(
    planId: string,
    input: z.input<typeof StepInput>,
  ): PlanStep {
    const parsed = StepInput.parse(input);
    assertSafeObject(parsed);

    // Проверяем, что план существует и активен.
    const plan = this.db
      .prepare(`SELECT status FROM plans WHERE id = @id`)
      .get({ id: planId }) as { status: string } | undefined;
    if (!plan) throw new Error(`План не найден: ${planId}`);
    if (plan.status !== "active") {
      throw new Error(`План в статусе ${plan.status}, нельзя добавлять шаги`);
    }

    // Проверяем существование зависимостей.
    for (const depId of parsed.dependsOn) {
      const dep = this.db
        .prepare(
          `SELECT id FROM plan_steps WHERE id = @id AND plan_id = @plan`,
        )
        .get({ id: depId, plan: planId });
      if (!dep) throw new Error(`Зависимость не найдена: ${depId}`);
    }

    const ordinal = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), 0) + 1 as next FROM plan_steps WHERE plan_id = @plan`,
      )
      .get({ plan: planId }) as { next: number };

    const id = this.generateId("step");
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO plan_steps
         (id, plan_id, ordinal, title, description, status, depends_on, created_at, updated_at)
         VALUES (@id, @plan, @ord, @title, @desc, 'pending', @deps, @now, @now)`,
      )
      .run({
        id,
        plan: planId,
        ord: ordinal.next,
        title: parsed.title,
        desc: parsed.description,
        deps: JSON.stringify(parsed.dependsOn),
        now,
      });

    this.audit.log({
      source: "planner",
      action: "add_step",
      payload: { planId, stepId: id, title: parsed.title },
      outcome: "ok",
    });

    return {
      id,
      planId,
      ordinal: ordinal.next,
      title: parsed.title,
      description: parsed.description,
      status: "pending",
      dependsOn: parsed.dependsOn,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Переход статуса шага. Проверяет, что переход допустим.
   * Это защищает от тихих несогласованностей в state machine.
   */
  updateStepStatus(stepId: string, newStatus: StepStatus): PlanStep {
    const row = this.db
      .prepare(
        `SELECT id, plan_id, ordinal, title, description, status, depends_on, created_at
         FROM plan_steps WHERE id = @id`,
      )
      .get({ id: stepId }) as
      | {
          id: string;
          plan_id: string;
          ordinal: number;
          title: string;
          description: string;
          status: StepStatus;
          depends_on: string;
          created_at: string;
        }
      | undefined;
    if (!row) throw new Error(`Шаг не найден: ${stepId}`);

    const allowed = ALLOWED_TRANSITIONS[row.status];
    if (!allowed.includes(newStatus)) {
      this.audit.log({
        source: "planner",
        action: "update_step_status",
        payload: { stepId, from: row.status, to: newStatus },
        outcome: "denied",
        reason: `недопустимый переход ${row.status} → ${newStatus}`,
      });
      throw new Error(
        `Недопустимый переход статуса: ${row.status} → ${newStatus}`,
      );
    }

    // Если переходим в in_progress, проверяем, что все зависимости выполнены.
    if (newStatus === "in_progress") {
      const deps = JSON.parse(row.depends_on) as string[];
      for (const depId of deps) {
        const dep = this.db
          .prepare(`SELECT status FROM plan_steps WHERE id = @id`)
          .get({ id: depId }) as { status: string } | undefined;
        if (!dep || dep.status !== "done") {
          throw new Error(
            `Зависимость ${depId} не выполнена (статус: ${dep?.status ?? "не найдена"})`,
          );
        }
      }
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE plan_steps SET status = @s, updated_at = @now WHERE id = @id`,
      )
      .run({ s: newStatus, now, id: stepId });

    this.audit.log({
      source: "planner",
      action: "update_step_status",
      payload: { stepId, from: row.status, to: newStatus },
      outcome: "ok",
    });

    return {
      id: row.id,
      planId: row.plan_id,
      ordinal: row.ordinal,
      title: row.title,
      description: row.description,
      status: newStatus,
      dependsOn: JSON.parse(row.depends_on),
      createdAt: row.created_at,
      updatedAt: now,
    };
  }

  getPlan(planId: string): Plan | null {
    const planRow = this.db
      .prepare(
        `SELECT id, goal, status, created_at, updated_at FROM plans WHERE id = @id`,
      )
      .get({ id: planId }) as
      | {
          id: string;
          goal: string;
          status: "active" | "completed" | "abandoned";
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!planRow) return null;

    const stepRows = this.db
      .prepare(
        `SELECT id, plan_id, ordinal, title, description, status, depends_on, created_at, updated_at
         FROM plan_steps WHERE plan_id = @id ORDER BY ordinal ASC`,
      )
      .all({ id: planId }) as Array<{
      id: string;
      plan_id: string;
      ordinal: number;
      title: string;
      description: string;
      status: StepStatus;
      depends_on: string;
      created_at: string;
      updated_at: string;
    }>;

    return {
      id: planRow.id,
      goal: planRow.goal,
      status: planRow.status,
      createdAt: planRow.created_at,
      updatedAt: planRow.updated_at,
      steps: stepRows.map((r) => ({
        id: r.id,
        planId: r.plan_id,
        ordinal: r.ordinal,
        title: r.title,
        description: r.description,
        status: r.status,
        dependsOn: JSON.parse(r.depends_on),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  }

  /** Возвращает шаги, которые можно начать прямо сейчас (все зависимости done). */
  getReadySteps(planId: string): PlanStep[] {
    const plan = this.getPlan(planId);
    if (!plan) return [];
    const doneIds = new Set(
      plan.steps.filter((s) => s.status === "done").map((s) => s.id),
    );
    return plan.steps.filter(
      (s) =>
        s.status === "pending" &&
        s.dependsOn.every((d) => doneIds.has(d)),
    );
  }

  listPlans(limit = 50): Pick<Plan, "id" | "goal" | "status" | "createdAt">[] {
    const lim = Math.min(Math.max(1, Math.floor(limit)), 500);
    const rows = this.db
      .prepare(
        `SELECT id, goal, status, created_at FROM plans
         ORDER BY created_at DESC LIMIT @lim`,
      )
      .all({ lim }) as Array<{
      id: string;
      goal: string;
      status: "active" | "completed" | "abandoned";
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
