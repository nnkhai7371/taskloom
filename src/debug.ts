/**
 * Internal debug module for task-tree introspection.
 * No allocations when debugEnabled is false.
 */

import type { TaskStatus } from "./task.js";

/**
 * Pluggable logger for task-debug output. Implement this interface and pass
 * to enableTaskDebug(logger) to route lifecycle and default visualizer
 * output to your logger (e.g. debug for tree output, error for subscriber
 * throw reporting). Optional meta supports structured loggers.
 */
export interface Logger {
  /** Log at debug level (e.g. lifecycle and default visualizer output). */
  debug(msg: string, meta?: object): void;
  /** Log at warn level. */
  warn(msg: string, meta?: object): void;
  /** Log at error level (e.g. subscriber-throw reporting). */
  error(msg: string, meta?: object): void;
}

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

export type ScopeType = "sync" | "race" | "rush" | "branch" | "spawn";

type TaskDebugSubscriber = (event: TaskDebugEvent) => void;

type MirrorScope = { id: number; type: ScopeType; children: Array<MirrorScope | MirrorTask> };
type MirrorTask = {
  id: number;
  name?: string;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
};

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

/**
 * Instance-based debugger for task-tree introspection. Holds all debug state;
 * one default instance is used by the public API. Advanced use: create your
 * own instance or use the exported singleton for tests.
 */
export class TaskloomDebugger {
  #debugEnabled = false;
  #logger: Logger | null = null;
  #subscribers: TaskDebugSubscriber[] | null = null;
  #nextScopeId = 0;
  #nextTaskId = 0;
  #scopeStack: ScopeNode[] = [];
  readonly #taskIdToNode = new Map<number, TaskNode>();
  #mirrorStack: MirrorScope[] = [];
  #mirrorTaskById = new Map<number, MirrorTask>();
  #detachedRoot: MirrorScope | null = null;
  #printedRootIds = new Set<number>();
  #defaultVisualizerUnsubscribe: (() => void) | null = null;
  #hasDefaultVisualizer = false;

  #sink(level: "debug" | "warn" | "error", msg: string, meta?: object): void {
    const logger = this.#logger;
    if (logger) {
      try {
        logger[level](msg, meta);
        return;
      } catch {
        // Fall back to console if logger throws
      }
    }
    if (level === "debug") {
      // eslint-disable-next-line no-console
      console.log(msg);
    } else if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(msg);
    } else {
      // eslint-disable-next-line no-console
      console.error(msg);
    }
  }

  #printCompletedScope(scope: MirrorScope): void {
    if (this.#printedRootIds.has(scope.id)) return;
    if (this.#printedRootIds.size > 10_000) {
      this.#printedRootIds.clear();
    }
    const text = this.#formatMirrorTree(scope);
    if (text) {
      this.#sink("debug", text);
      this.#printedRootIds.add(scope.id);
    }
  }

  #applyMirrorEventTaskUpdated(event: Extract<TaskDebugEvent, { kind: "taskUpdated" }>): "print" | "return" {
    const node = this.#mirrorTaskById.get(event.taskId);
    if (node) {
      node.status = event.status;
      if (event.timing?.endTime) node.endTime = event.timing.endTime;
    }
    if (this.#detachedRoot && this.#allTasksComplete(this.#detachedRoot)) return "print";
    return "return";
  }

  #applyMirrorEvent(event: TaskDebugEvent): "print" | "return" {
    if (event.kind === "scopeOpened") {
      const node: MirrorScope = { id: event.scopeId, type: event.type, children: [] };
      const parent = this.#mirrorStack.at(-1);
      if (parent) parent.children.push(node);
      this.#mirrorStack.push(node);
      return "return";
    }
    if (event.kind === "scopeClosed") {
      const scope = this.#mirrorStack.pop();
      if (this.#mirrorStack.length === 0 && scope) {
        this.#detachedRoot = scope;
        return "print";
      }
      return "return";
    }
    if (event.kind === "taskRegistered") {
      const parent = this.#mirrorStack.at(-1);
      const node: MirrorTask = {
        id: event.taskId,
        name: event.name,
        status: "running",
        startTime: Date.now(),
      };
      this.#mirrorTaskById.set(event.taskId, node);
      if (parent) parent.children.push(node);
      return "return";
    }
    return this.#applyMirrorEventTaskUpdated(event);
  }

  #allTasksComplete(scope: MirrorScope): boolean {
    for (const child of scope.children) {
      if ("status" in child) {
        if (child.status === "running") return false;
      } else if (!this.#allTasksComplete(child)) {
        return false;
      }
    }
    return true;
  }

  #defaultInPlaceVisualizer(event: TaskDebugEvent): void {
    const action = this.#applyMirrorEvent(event);
    if (action === "print" && this.#detachedRoot) {
      const complete = this.#allTasksComplete(this.#detachedRoot);
      if (complete) {
        this.#printCompletedScope(this.#detachedRoot);
        this.#detachedRoot = null;
      }
    }
  }

  #isInternalTaskName(name: string | undefined): boolean {
    if (!name || typeof name !== "string") return true;
    const s = name.toLowerCase();
    return s.includes("taskloom") && (s.includes("dist") || s.includes("primitives"));
  }

  #formatMirrorTree(node: MirrorScope, prefix = ""): string {
    const head = `${node.type}#${node.id}`;
    let lines: string[] = [head];
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isLast = i === node.children.length - 1;
      const branch = isLast ? "└─ " : "├─ ";
      const subPrefix = prefix + (isLast ? "   " : "│  ");
      if ("status" in child) {
        const namePart =
          child.name && !this.#isInternalTaskName(child.name) ? ` ${child.name}` : "";
        const duration =
          child.endTime ? ` in ${child.endTime - child.startTime}ms` : "";
        lines.push(prefix + branch + `task#${child.id}${namePart} (${child.status}${duration})`);
      } else {
        const childStr = this.#formatMirrorTree(child, subPrefix);
        const childLines = childStr.split("\n");
        lines = lines.concat(
          [prefix + branch + childLines[0]],
          childLines.slice(1),
        );
      }
    }
    return lines.join("\n");
  }

  #emitTaskDebugEvent(event: TaskDebugEvent): void {
    if (this.#subscribers === null || this.#subscribers.length === 0) return;
    for (const fn of this.#subscribers) {
      try {
        fn(event);
      } catch (err) {
        this.#sink("error", "[taskloom] subscribeTaskDebug subscriber threw:", { error: err });
      }
    }
  }

  #formatTaskNode(task: TaskNode): string {
    const namePart =
      task.name && !this.#isInternalTaskName(task.name) ? ` ${task.name}` : "";
    const duration =
      task.endTime ? ` in ${task.endTime - task.startTime}ms` : "";
    return `task#${task.id}${namePart} (${task.status}${duration})`;
  }

  #formatTree(node: ScopeNode, prefix = ""): string {
    const head = `${node.type}#${node.id}`;
    let lines: string[] = [head];
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const branch = isLast ? "└─ " : "├─ ";
      const subPrefix = prefix + (isLast ? "   " : "│  ");
      if ("status" in child) {
        lines.push(prefix + branch + this.#formatTaskNode(child));
      } else {
        const childStr = this.#formatTree(child, subPrefix);
        const childLines = childStr.split("\n");
        lines = lines.concat(
          [prefix + branch + childLines[0]],
          childLines.slice(1),
        );
      }
    }
    return lines.join("\n");
  }

  #clearTaskIdsFromTree(scope: ScopeNode): void {
    for (const child of scope.children) {
      if ("status" in child) {
        this.#taskIdToNode.delete(child.id);
      } else {
        this.#clearTaskIdsFromTree(child);
      }
    }
  }

  getCurrentScope(): ScopeNode | undefined {
    return this.#scopeStack.at(-1);
  }

  enable(logger?: Logger): void {
    this.#logger = logger ?? null;
    this.#debugEnabled = true;
    if (!this.#defaultVisualizerUnsubscribe) {
      this.#defaultVisualizerUnsubscribe = this.subscribe(this.#defaultInPlaceVisualizer.bind(this));
      this.#hasDefaultVisualizer = true;
    }
  }

  disable(): void {
    this.#debugEnabled = false;
    this.#defaultVisualizerUnsubscribe = null;
    this.#hasDefaultVisualizer = false;
    this.#subscribers = null;
    this.#mirrorStack = [];
    this.#mirrorTaskById = new Map();
    this.#detachedRoot = null;
    this.#printedRootIds = new Set();
    this.#scopeStack = [];
    this.#taskIdToNode.clear();
  }

  subscribe(callback: TaskDebugSubscriber): () => void {
    if (!this.#debugEnabled) return () => {};
    this.#subscribers ??= [];
    this.#subscribers.push(callback);
    return () => {
      if (this.#subscribers === null) return;
      const i = this.#subscribers.indexOf(callback);
      if (i !== -1) this.#subscribers.splice(i, 1);
    };
  }

  isEnabled(): boolean {
    return this.#debugEnabled;
  }

  getCallerName(depth: number = 1): string | undefined {
    let stack: string | undefined;
    try {
      stack = new Error("stack capture for getCallerName").stack;
    } catch {
      return undefined;
    }
    if (!stack || typeof stack !== "string") return undefined;
    const lines = stack.split("\n");
    const frameIndex = 1 + depth;
    if (frameIndex >= lines.length) return undefined;
    const line = lines[frameIndex];
    if (!line || typeof line !== "string") return undefined;
    const trimmed = line.trim();
    // V8/Node: "at functionName (file:line:col)" or "at file:line:col"
    let match = /^\s*at\s+(.+)$/.exec(trimmed);
    if (match) return match[1];
    // Safari: "functionName@file:line:col"
    match = /^([^@]+)@/.exec(trimmed);
    if (match) return match[1];
    // Firefox: "@file:line:col" or "functionName@file:line:col"
    match = /^([^@]*)@/.exec(trimmed);
    if (match?.[1]) return match[1];
    return trimmed || undefined;
  }

  pushScope(type: ScopeType): void {
    if (!this.#debugEnabled) return;
    const id = ++this.#nextScopeId;
    const node: ScopeNode = { id, type, children: [] };
    const parent = this.getCurrentScope();
    if (parent) parent.children.push(node);
    this.#scopeStack.push(node);
    if (this.#subscribers?.length) {
      this.#emitTaskDebugEvent({ kind: "scopeOpened", scopeId: id, type });
    }
  }

  popScope(): void {
    if (!this.#debugEnabled) return;
    const node = this.#scopeStack.pop();
    if (!node) return;
    if (this.#subscribers?.length) {
      this.#emitTaskDebugEvent({ kind: "scopeClosed", scopeId: node.id, type: node.type });
    }
    if (this.#scopeStack.length === 0) {
      if (!this.#hasDefaultVisualizer) {
        const text = this.#formatTree(node);
        if (text) {
          this.#sink("debug", text);
        }
      }
      this.#clearTaskIdsFromTree(node);
    }
  }

  registerTask(name?: string): number | undefined {
    if (!this.#debugEnabled) return undefined;
    const id = ++this.#nextTaskId;
    const node: TaskNode = {
      id,
      name,
      status: "running",
      startTime: Date.now(),
    };
    this.#taskIdToNode.set(id, node);
    const scope = this.getCurrentScope();
    if (scope) scope.children.push(node);
    if (this.#subscribers?.length) {
      this.#emitTaskDebugEvent({
        kind: "taskRegistered",
        taskId: id,
        name,
        parentScopeId: scope?.id,
      });
    }
    return id;
  }

  updateTask(taskId: number | undefined, status: TaskStatus): void {
    if (taskId === undefined || !this.#debugEnabled) return;
    const node = this.#taskIdToNode.get(taskId);
    const endTime = Date.now();
    if (node) {
      node.status = status;
      node.endTime = endTime;
    }
    if (this.#subscribers?.length) {
      this.#emitTaskDebugEvent({
        kind: "taskUpdated",
        taskId,
        status,
        timing: node
          ? { startTime: node.startTime, endTime: node.endTime }
          : { endTime },
      });
    }
  }
}

const defaultDebugger = new TaskloomDebugger();

/**
 * Default singleton debugger used by the public API. Advanced use only;
 * prefer enableTaskDebug(), subscribeTaskDebug(), etc.
 */
export const taskloomDebugger = defaultDebugger;

/**
 * Enables task-tree introspection for the default debugger. Lifecycle and
 * default visualizer output go to console unless a logger is supplied.
 * When a Logger is provided, all task-debug output (lifecycle lines and
 * subscriber-throw reporting) is sent via that logger instead of console.
 * @param logger - Optional logger; when provided, task-debug output uses
 *   logger.debug / logger.error instead of console.
 */
export function enableTaskDebug(logger?: Logger): void {
  try {
    defaultDebugger.enable(logger);
  } catch {
    // Graceful degradation: when stack or debug APIs are unavailable (e.g. in some browsers), no-op
  }
}

/** Internal use for tests only; not part of public API. */
export function disableTaskDebug(): void {
  defaultDebugger.disable();
}

export function subscribeTaskDebug(callback: (event: TaskDebugEvent) => void): () => void {
  return defaultDebugger.subscribe(callback);
}

export function isTaskDebugEnabled(): boolean {
  return defaultDebugger.isEnabled();
}

export function getCallerName(depth: number = 1): string | undefined {
  try {
    return defaultDebugger.getCallerName(depth);
  } catch {
    return undefined;
  }
}

export function pushScope(type: ScopeType): void {
  defaultDebugger.pushScope(type);
}

export function popScope(): void {
  defaultDebugger.popScope();
}

export function registerTask(name?: string): number | undefined {
  return defaultDebugger.registerTask(name);
}

export function updateTask(
  taskId: number | undefined,
  status: TaskStatus,
): void {
  defaultDebugger.updateTask(taskId, status);
}
