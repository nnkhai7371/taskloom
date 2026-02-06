/**
 * Internal debug module for task-tree introspection.
 * No allocations when debugEnabled is false.
 */

import type { TaskStatus } from "./task.js";

/** Event payload for realtime task debug (discriminated union). */
export type TaskDebugEvent =
  | { kind: "scopeOpened"; scopeId: number; type: ScopeType }
  | { kind: "scopeClosed"; scopeId: number; type: ScopeType }
  | {
      kind: "taskRegistered";
      taskId: number;
      name?: string;
      parentScopeId?: number;
    }
  | {
      kind: "taskUpdated";
      taskId: number;
      status: TaskStatus;
      timing?: { startTime?: number; endTime?: number };
    };

type TaskDebugSubscriber = (event: TaskDebugEvent) => void;

let debugEnabled = false;
/** Allocated only when debug is enabled and at least one subscriber exists. */
let subscribers: TaskDebugSubscriber[] | null = null;
let defaultVisualizerUnsubscribe: (() => void) | null = null;
let hasDefaultVisualizer = false;

type MirrorScope = { id: number; type: ScopeType; children: Array<MirrorScope | MirrorTask> };
type MirrorTask = {
  id: number;
  name?: string;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
};

/** Mirror state for the default in-place visualizer (only used when TTY). */
let mirrorStack: MirrorScope[] = [];
let mirrorTaskById = new Map<number, MirrorTask>();
/** When a root scope pops but tasks may still complete later (e.g. spawn), we keep it for redraws. */
let detachedRoot: MirrorScope | null = null;
/** Set of root scope IDs we've already printed (to avoid duplicates). */
let printedRootIds = new Set<number>();

function getMirrorRoot(): MirrorScope | null {
  return mirrorStack[0] ?? detachedRoot;
}

/**
 * Prints a completed scope tree once. Called when a scope closes and all its tasks are in final state.
 * Uses print-once strategy (no ANSI cursor movement) to avoid duplicate output on Windows.
 */
function printCompletedScope(scope: MirrorScope): void {
  if (printedRootIds.has(scope.id)) return;
  const text = formatMirrorTree(scope);
  if (text) {
    // eslint-disable-next-line no-console
    console.log(text);
    printedRootIds.add(scope.id);
  }
}

function applyMirrorEvent(event: TaskDebugEvent): "print" | "return" {
  if (event.kind === "scopeOpened") {
    const node: MirrorScope = { id: event.scopeId, type: event.type, children: [] };
    const parent = mirrorStack.at(-1);
    if (parent) parent.children.push(node);
    mirrorStack.push(node);
    return "return";
  }
  if (event.kind === "scopeClosed") {
    const scope = mirrorStack.pop();
    if (mirrorStack.length === 0 && scope) {
      // Root scope closed - print it once
      detachedRoot = scope;
      return "print";
    }
    return "return";
  }
  if (event.kind === "taskRegistered") {
    const parent = mirrorStack.at(-1);
    const node: MirrorTask = {
      id: event.taskId,
      name: event.name,
      status: "running",
      startTime: Date.now(),
    };
    mirrorTaskById.set(event.taskId, node);
    if (parent) parent.children.push(node);
    return "return";
  }
  // taskUpdated
  const node = mirrorTaskById.get(event.taskId);
  if (node) {
    node.status = event.status;
    if (event.timing?.endTime != null) node.endTime = event.timing.endTime;
  }
  // If a detached root exists and all its tasks are complete, print it
  if (detachedRoot) {
    const complete = allTasksComplete(detachedRoot);
    if (complete) {
      return "print";
    }
  }
  return "return";
}

/** Check if all tasks in a scope tree are in a final state (not running). */
function allTasksComplete(scope: MirrorScope): boolean {
  for (const child of scope.children) {
    if ("status" in child) {
      if (child.status === "running") return false;
    } else {
      if (!allTasksComplete(child)) return false;
    }
  }
  return true;
}

/**
 * Default visualizer: maintains a mirror tree from events and prints each completed scope once.
 * Works for both TTY and non-TTY terminals using simple print-once strategy (no ANSI cursor movement).
 */
function defaultInPlaceVisualizer(event: TaskDebugEvent): void {
  const action = applyMirrorEvent(event);
  if (action === "print" && detachedRoot) {
    // Only print when all tasks in the scope are complete (not running)
    const complete = allTasksComplete(detachedRoot);
    if (complete) {
      printCompletedScope(detachedRoot);
      detachedRoot = null;
    }
    // Otherwise, keep waiting for task updates
  }
}

/** Returns true if name looks like taskloom internal (dist/primitives), so we hide it in the tree. */
function isInternalTaskName(name: string | undefined): boolean {
  if (!name || typeof name !== "string") return true;
  const s = name.toLowerCase();
  return s.includes("taskloom") && (s.includes("dist") || s.includes("primitives"));
}

function formatMirrorTree(node: MirrorScope, prefix = ""): string {
  const head = `${node.type}#${node.id}`;
  let lines: string[] = [head];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const branch = isLast ? "└─ " : "├─ ";
    const subPrefix = prefix + (isLast ? "   " : "│  ");
    if ("status" in child) {
      const namePart =
        child.name && !isInternalTaskName(child.name) ? ` ${child.name}` : "";
      const duration =
        child.endTime == null ? "" : ` in ${child.endTime - child.startTime}ms`;
      lines.push(prefix + branch + `task#${child.id}${namePart} (${child.status}${duration})`);
    } else {
      const childStr = formatMirrorTree(child, subPrefix);
      const childLines = childStr.split("\n");
      lines = lines.concat(
        [prefix + branch + childLines[0]],
        childLines.slice(1),
      );
    }
  }
  return lines.join("\n");
}

/**
 * Enables task-tree introspection for logging and debugging. When enabled, scope/task structure is tracked.
 * Each root scope is printed once when it closes and all its tasks have completed (even tasks that complete
 * after the scope closes, like spawn/branch). Call once at startup if you need debug output.
 */
export function enableTaskDebug(): void {
  debugEnabled = true;
  // Always subscribe the visualizer (works for both TTY and non-TTY)
  if (!defaultVisualizerUnsubscribe) {
    defaultVisualizerUnsubscribe = subscribeTaskDebug(defaultInPlaceVisualizer);
    hasDefaultVisualizer = true;
  }
}

/** Internal use for tests only; not part of public API. */
export function disableTaskDebug(): void {
  debugEnabled = false;
  defaultVisualizerUnsubscribe = null;
  hasDefaultVisualizer = false;
  subscribers = null;
  mirrorStack = [];
  mirrorTaskById = new Map();
  detachedRoot = null;
  printedRootIds = new Set();
  scopeStack = [];
  taskIdToNode.clear();
}

/**
 * Subscribes to realtime task debug events. When debug is enabled, the callback is invoked
 * for scopeOpened, scopeClosed, taskRegistered, and taskUpdated. Returns an unsubscribe function.
 * Subscriber list is allocated only when debug is enabled; zero cost when disabled.
 */
export function subscribeTaskDebug(callback: TaskDebugSubscriber): () => void {
  if (!debugEnabled) {
    return () => {};
  }
  subscribers ??= [];
  subscribers.push(callback);
  return () => {
    if (subscribers === null) return;
    const i = subscribers.indexOf(callback);
    if (i !== -1) subscribers.splice(i, 1);
  };
}

function emitTaskDebugEvent(event: TaskDebugEvent): void {
  if (subscribers === null || subscribers.length === 0) return;
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[taskloom] subscribeTaskDebug subscriber threw:", err);
    }
  }
}

export function isTaskDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Returns the callsite at the given stack depth using Error.stack.
 * depth 0 = caller of getCallerName; depth 1 = caller of that; etc.
 * Used for inferred task names when task debug is enabled. Returns undefined if parsing fails.
 */
export function getCallerName(depth: number = 1): string | undefined {
  const stack = new Error("stack capture for getCallerName").stack;
  if (!stack || typeof stack !== "string") return undefined;
  const lines = stack.split("\n");
  // Skip "Error" line; frame at index i is at line i+1. We want frame at 1 + depth.
  const frameIndex = 1 + depth;
  if (frameIndex >= lines.length) return undefined;
  const line = lines[frameIndex];
  if (!line || typeof line !== "string") return undefined;
  const trimmed = line.trim();
  // Strip "at " prefix if present
  const atMatch = /^\s*at\s+(.+)$/.exec(trimmed);
  const frame = atMatch ? atMatch[1] : trimmed;
  return frame || undefined;
}

// --- Scope stack and IDs (only used when debugEnabled) ---

export type ScopeType = "sync" | "race" | "rush" | "branch" | "spawn";

type TaskNode = {
  id: number;
  name?: string;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
};

type ScopeNode = {
  id: number;
  type: ScopeType;
  children: Array<ScopeNode | TaskNode>;
};

let nextScopeId = 0;
let nextTaskId = 0;
let scopeStack: ScopeNode[] = [];
const taskIdToNode = new Map<number, TaskNode>();

function getCurrentScope(): ScopeNode | undefined {
  return scopeStack.at(-1);
}

export function pushScope(type: ScopeType): void {
  if (!debugEnabled) return;
  const id = ++nextScopeId;
  const node: ScopeNode = { id, type, children: [] };
  const parent = getCurrentScope();
  if (parent) {
    parent.children.push(node);
  }
  scopeStack.push(node);
  if (subscribers?.length) {
    emitTaskDebugEvent({ kind: "scopeOpened", scopeId: id, type });
  }
}

export function popScope(): void {
  if (!debugEnabled) return;
  const node = scopeStack.pop();
  if (!node) return;
  if (subscribers?.length) {
    emitTaskDebugEvent({ kind: "scopeClosed", scopeId: node.id, type: node.type });
  }
  if (scopeStack.length === 0) {
    if (!hasDefaultVisualizer) {
      const text = formatTree(node);
      if (text) {
        // eslint-disable-next-line no-console
        console.log(text);
      }
    }
    clearTaskIdsFromTree(node);
  }
}

function clearTaskIdsFromTree(scope: ScopeNode): void {
  for (const child of scope.children) {
    if ("status" in child) {
      taskIdToNode.delete(child.id);
    } else {
      clearTaskIdsFromTree(child);
    }
  }
}

/** Returns task id when debug enabled, undefined otherwise. No allocation when disabled. */
export function registerTask(name?: string): number | undefined {
  if (!debugEnabled) return undefined;
  const id = ++nextTaskId;
  const node: TaskNode = {
    id,
    name,
    status: "running",
    startTime: Date.now(),
  };
  taskIdToNode.set(id, node);
  const scope = getCurrentScope();
  if (scope) {
    scope.children.push(node);
  }
  if (subscribers?.length) {
    emitTaskDebugEvent({
      kind: "taskRegistered",
      taskId: id,
      name,
      parentScopeId: scope?.id,
    });
  }
  return id;
}

export function updateTask(
  taskId: number | undefined,
  status: TaskStatus,
): void {
  if (taskId === undefined || !debugEnabled) return;
  const node = taskIdToNode.get(taskId);
  const endTime = Date.now();
  if (node) {
    node.status = status;
    node.endTime = endTime;
  }
  // Emit even when node was cleared (scope already closed) so the mirror visualizer
  // can update tasks that complete after their scope closes (e.g. branch, spawn).
  if (subscribers?.length) {
    emitTaskDebugEvent({
      kind: "taskUpdated",
      taskId,
      status,
      timing: node
        ? { startTime: node.startTime, endTime: node.endTime }
        : { endTime },
    });
  }
}

// --- Tree formatting ---

function formatTaskNode(task: TaskNode): string {
  const namePart =
    task.name && !isInternalTaskName(task.name) ? ` ${task.name}` : "";
  const duration =
    task.endTime == null ? "" : ` in ${task.endTime - task.startTime}ms`;
  return `task#${task.id}${namePart} (${task.status}${duration})`;
}

function formatTree(node: ScopeNode, prefix = ""): string {
  const head = `${node.type}#${node.id}`;
  let lines: string[] = [head];
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const isLast = i === children.length - 1;
    const branch = isLast ? "└─ " : "├─ ";
    const subPrefix = prefix + (isLast ? "   " : "│  ");
    if ("status" in child) {
      lines.push(prefix + branch + formatTaskNode(child));
    } else {
      const childStr = formatTree(child, subPrefix);
      const childLines = childStr.split("\n");
      lines = lines.concat(
        [prefix + branch + childLines[0]],
        childLines.slice(1),
      );
    }
  }
  return lines.join("\n");
}
