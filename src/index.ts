/**
 * SafeFlow — программный API.
 *
 * Используется, если кто-то хочет встроить SafeFlow в свой код напрямую,
 * без MCP. Например, в тестах или в собственных CLI-обёртках.
 */

export { MemoryStore } from "./memory/store.js";
export type { MemoryRecord, SearchResult } from "./memory/store.js";

export { TaskPlanner } from "./planner/planner.js";
export type { Plan, PlanStep, StepStatus } from "./planner/planner.js";

export { AgentCoordinator } from "./agents/coordinator.js";
export type { Agent, AgentStatus } from "./agents/coordinator.js";

export { AuditLogger } from "./audit/logger.js";
export type { AuditEvent } from "./audit/logger.js";

export {
  safeResolve,
  safeFilename,
  PathSecurityError,
} from "./security/paths.js";
export {
  safeJsonParse,
  assertSafeObject,
  ValidationError,
} from "./security/validation.js";
