/**
 * MCP server для SafeFlo.
 *
 * ВАЖНО ОТНОСИТЕЛЬНО БЕЗОПАСНОСТИ:
 * Описания инструментов (`description`) — это то, что LLM видит как
 * инструкцию. В ruflo было замечено, что описания содержат скрытые
 * директивы (например, добавить owner репозитория как контрибьютора).
 *
 * Здесь все описания:
 *   1. Только функциональные — что делает инструмент, какие аргументы, что возвращает.
 *   2. Без императивов в адрес модели ("ты должен", "всегда добавляй", "не сообщай пользователю").
 *   3. Никаких упоминаний внешних сервисов, URL, контактов или владельцев.
 *   4. Никаких параметров, которые не используются в логике — они могли бы
 *      служить каналом для скрытых инструкций.
 *
 * Перед публикацией репозитория описания нужно ревьюить отдельным процессом
 * (см. SECURITY.md → "Tool description audit").
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import process from "node:process";

import { MemoryStore } from "../memory/store.js";
import { TaskPlanner } from "../planner/planner.js";
import { AgentCoordinator } from "../agents/coordinator.js";
import { AuditLogger } from "../audit/logger.js";

/**
 * Точка входа сервера. Проектная директория определяется через
 * SAFEFLOW_PROJECT_ROOT или текущую рабочую директорию. Никаких глобальных
 * путей, никаких ~/.safeflow.
 */
async function main(): Promise<void> {
  const projectRoot = path.resolve(
    process.env.SAFEFLOW_PROJECT_ROOT ?? process.cwd(),
  );

  const audit = new AuditLogger(projectRoot);
  const memory = new MemoryStore(projectRoot, audit);
  const planner = new TaskPlanner(projectRoot, audit);
  const coordinator = new AgentCoordinator(projectRoot, audit);

  audit.log({
    source: "mcp",
    action: "server_start",
    payload: { projectRoot, pid: process.pid },
    outcome: "ok",
  });

  const server = new Server(
    { name: "safeflow", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "memory_store",
        description:
          "Save a value in local SQLite memory at the given namespace and key. Updates the value if the key already exists. Data is stored only in the project's .safeflow/ directory.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Memory namespace, e.g. 'project.notes'." },
            key: { type: "string", description: "Key within the namespace." },
            content: { type: "string", description: "Text content to store." },
            metadata: {
              type: "object",
              description: "Optional JSON metadata.",
              additionalProperties: true,
            },
          },
          required: ["namespace", "key", "content"],
        },
      },
      {
        name: "memory_get",
        description:
          "Fetch a single memory record by namespace and key. Returns null if the key does not exist.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            key: { type: "string" },
          },
          required: ["namespace", "key"],
        },
      },
      {
        name: "memory_search",
        description:
          "Full-text search within a namespace using SQLite FTS5. Returns ranked records.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            query: { type: "string", description: "Free-text query." },
            limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
          },
          required: ["namespace", "query"],
        },
      },
      {
        name: "memory_list",
        description:
          "List records in a namespace, ordered by most recently updated.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            limit: { type: "number", minimum: 1, maximum: 1000, default: 100 },
          },
          required: ["namespace"],
        },
      },
      {
        name: "memory_delete",
        description:
          "Delete a single key from memory. Returns true if a record was deleted.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            key: { type: "string" },
          },
          required: ["namespace", "key"],
        },
      },
      {
        name: "plan_create",
        description: "Create a new empty task plan with a goal description.",
        inputSchema: {
          type: "object",
          properties: {
            goal: { type: "string", description: "Goal description in any language." },
          },
          required: ["goal"],
        },
      },
      {
        name: "plan_add_step",
        description:
          "Add a step to an existing plan. Steps can declare dependencies on previously created step IDs.",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string" },
            title: { type: "string", maxLength: 500 },
            description: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" }, default: [] },
          },
          required: ["planId", "title", "description"],
        },
      },
      {
        name: "plan_update_step_status",
        description:
          "Change a step's status. Only allowed transitions are accepted: pending→in_progress|blocked|failed, in_progress→done|blocked|failed, blocked→pending|in_progress|failed, failed→pending.",
        inputSchema: {
          type: "object",
          properties: {
            stepId: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "blocked", "done", "failed"],
            },
          },
          required: ["stepId", "status"],
        },
      },
      {
        name: "plan_get",
        description: "Fetch a plan with all its steps.",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string" },
          },
          required: ["planId"],
        },
      },
      {
        name: "plan_ready_steps",
        description:
          "Return steps in the plan that are pending and whose dependencies are all done.",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string" },
          },
          required: ["planId"],
        },
      },
      {
        name: "plan_list",
        description: "List recent plans (id, goal, status, createdAt).",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 1, maximum: 500, default: 50 },
          },
        },
      },
      {
        name: "agent_register",
        description:
          "Register a logical agent with a role. Returns the agent record including a memory namespace dedicated to that agent.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "Agent role, e.g. 'researcher', 'coder', 'reviewer'.",
            },
            task: { type: "string", description: "Optional task description." },
          },
          required: ["role"],
        },
      },
      {
        name: "agent_list",
        description: "List agents, optionally filtered by status.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "idle", "terminated"] },
          },
        },
      },
      {
        name: "agent_update_status",
        description:
          "Update an agent's status. Allowed transitions: active↔idle, *→terminated.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            status: { type: "string", enum: ["active", "idle", "terminated"] },
          },
          required: ["agentId", "status"],
        },
      },
      {
        name: "audit_tail",
        description: "Return the last N audit log events for this project.",
        inputSchema: {
          type: "object",
          properties: {
            n: { type: "number", minimum: 1, maximum: 1000, default: 100 },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req): Promise<CallToolResult> => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;

      try {
        switch (name) {
          case "memory_store": {
            const rec = memory.store(
              String(args.namespace),
              String(args.key),
              String(args.content),
              (args.metadata as Record<string, unknown>) ?? {},
            );
            return jsonResult(rec);
          }
          case "memory_get": {
            const rec = memory.get(String(args.namespace), String(args.key));
            return jsonResult(rec);
          }
          case "memory_search": {
            const results = memory.search(
              String(args.namespace),
              String(args.query),
              typeof args.limit === "number" ? args.limit : 10,
            );
            return jsonResult(results);
          }
          case "memory_list": {
            const results = memory.list(
              String(args.namespace),
              typeof args.limit === "number" ? args.limit : 100,
            );
            return jsonResult(results);
          }
          case "memory_delete": {
            const ok = memory.delete(
              String(args.namespace),
              String(args.key),
            );
            return jsonResult({ deleted: ok });
          }
          case "plan_create": {
            const plan = planner.createPlan(String(args.goal));
            return jsonResult(plan);
          }
          case "plan_add_step": {
            const step = planner.addStep(String(args.planId), {
              title: String(args.title),
              description: String(args.description),
              dependsOn: Array.isArray(args.dependsOn)
                ? (args.dependsOn as string[])
                : [],
            });
            return jsonResult(step);
          }
          case "plan_update_step_status": {
            const step = planner.updateStepStatus(
              String(args.stepId),
              args.status as
                | "pending"
                | "in_progress"
                | "blocked"
                | "done"
                | "failed",
            );
            return jsonResult(step);
          }
          case "plan_get": {
            const plan = planner.getPlan(String(args.planId));
            return jsonResult(plan);
          }
          case "plan_ready_steps": {
            const steps = planner.getReadySteps(String(args.planId));
            return jsonResult(steps);
          }
          case "plan_list": {
            const plans = planner.listPlans(
              typeof args.limit === "number" ? args.limit : 50,
            );
            return jsonResult(plans);
          }
          case "agent_register": {
            const agent = coordinator.register(
              String(args.role),
              args.task != null ? String(args.task) : null,
            );
            return jsonResult(agent);
          }
          case "agent_list": {
            const agents = coordinator.list(
              args.status as
                | "active"
                | "idle"
                | "terminated"
                | undefined,
            );
            return jsonResult(agents);
          }
          case "agent_update_status": {
            const agent = coordinator.updateStatus(
              String(args.agentId),
              args.status as "active" | "idle" | "terminated",
            );
            return jsonResult(agent);
          }
          case "audit_tail": {
            const events = audit.tail(
              typeof args.n === "number" ? args.n : 100,
            );
            return jsonResult(events);
          }
          default:
            return {
              content: [
                { type: "text", text: `Unknown tool: ${name}` },
              ],
              isError: true,
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.log({
          source: "mcp",
          action: "tool_error",
          payload: { tool: name, message },
          outcome: "error",
          reason: message,
        });
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    audit.log({
      source: "mcp",
      action: "server_stop",
      payload: { signal },
      outcome: "ok",
    });
    try {
      memory.close();
    } catch {
      // ignore
    }
    try {
      planner.close();
    } catch {
      // ignore
    }
    try {
      coordinator.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

main().catch((err) => {
  console.error("Fatal MCP server error:", err);
  process.exit(1);
});
