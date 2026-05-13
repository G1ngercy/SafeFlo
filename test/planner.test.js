import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskPlanner } from "../dist/planner/planner.js";
import { AuditLogger } from "../dist/audit/logger.js";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safeflow-plan-"));
}

test("planner: создание плана и шагов", () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const p = new TaskPlanner(root, audit);

  const plan = p.createPlan("Реализовать аутентификацию");
  const s1 = p.addStep(plan.id, {
    title: "Спроектировать схему БД",
    description: "Таблицы users, sessions",
    dependsOn: [],
  });
  const s2 = p.addStep(plan.id, {
    title: "Реализовать endpoints",
    description: "POST /login, POST /logout",
    dependsOn: [s1.id],
  });

  const full = p.getPlan(plan.id);
  assert.ok(full);
  assert.equal(full.steps.length, 2);
  assert.equal(full.steps[0].id, s1.id);
  assert.equal(full.steps[1].dependsOn[0], s1.id);
  p.close();
});

test("planner: запрещает недопустимый переход", () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const p = new TaskPlanner(root, audit);

  const plan = p.createPlan("test");
  const s = p.addStep(plan.id, { title: "step", description: "d", dependsOn: [] });

  // pending → done напрямую запрещён
  assert.throws(() => p.updateStepStatus(s.id, "done"));
  p.close();
});

test("planner: блокирует in_progress, если зависимость не выполнена", () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const p = new TaskPlanner(root, audit);

  const plan = p.createPlan("test");
  const s1 = p.addStep(plan.id, { title: "a", description: "d", dependsOn: [] });
  const s2 = p.addStep(plan.id, {
    title: "b",
    description: "d",
    dependsOn: [s1.id],
  });

  assert.throws(() => p.updateStepStatus(s2.id, "in_progress"));

  // Выполняем s1 — теперь s2 можно начать
  p.updateStepStatus(s1.id, "in_progress");
  p.updateStepStatus(s1.id, "done");
  const updated = p.updateStepStatus(s2.id, "in_progress");
  assert.equal(updated.status, "in_progress");
  p.close();
});

test("planner: getReadySteps возвращает только пригодные", () => {
  const root = mkTmp();
  const audit = new AuditLogger(root);
  const p = new TaskPlanner(root, audit);

  const plan = p.createPlan("test");
  const s1 = p.addStep(plan.id, { title: "a", description: "d", dependsOn: [] });
  const s2 = p.addStep(plan.id, {
    title: "b",
    description: "d",
    dependsOn: [s1.id],
  });

  let ready = p.getReadySteps(plan.id);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, s1.id);

  p.updateStepStatus(s1.id, "in_progress");
  p.updateStepStatus(s1.id, "done");

  ready = p.getReadySteps(plan.id);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, s2.id);
  p.close();
});
