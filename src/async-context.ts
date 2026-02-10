/**
 * Internal async-context storage abstraction.
 * Provides run(store, callback) and getStore() semantics without importing node:async_hooks.
 * Node uses native AsyncLocalStorage when available; browser uses an in-library ponyfill.
 */

export type AsyncContextStorage<T> = {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && typeof (value as PromiseLike<unknown>).then === "function";
}

/** Ponyfill: preserves store across await within the same run; no context leak between runs. */
function createPonyfillStorage<T>(): AsyncContextStorage<T> {
  let current: T | undefined;
  function wrapPromise<R>(store: T, value: R, prev: T | undefined): R {
    if (!isPromiseLike(value)) return value;
    return value.then(
      (v) => {
        current = store;
        try {
          return wrapPromise(store, v, prev) as Awaited<R>;
        } finally {
          current = prev;
        }
      },
      (e) => {
        current = store;
        try {
          return Promise.reject(e) as R;
        } finally {
          current = prev;
        }
      },
    ) as R;
  }
  return {
    run<R>(store: T, fn: () => R): R {
      const prev = current;
      current = store;
      try {
        const result = fn();
        return wrapPromise(store, result, prev);
      } finally {
        current = prev;
      }
    },
    getStore(): T | undefined {
      return current;
    },
  };
}

/**
 * Node implementation wrapper around AsyncLocalStorage.
 * Used when node:async_hooks is available.
 */
function createNodeStorage<T>(ALS: new () => { run<R>(store: T, fn: () => R): R; getStore(): T | undefined }): AsyncContextStorage<T> {
  const als = new ALS();
  return {
    run<R>(store: T, fn: () => R): R {
      return als.run(store, fn);
    },
    getStore(): T | undefined {
      return als.getStore();
    },
  };
}

function loadStorage(): AsyncContextStorage<unknown> {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  const isNode = proc?.versions?.node !== undefined;
  if (isNode) {
    try {
      const createRequire = new Function("return require('node:module').createRequire")() as (url: string | URL) => NodeRequire;
      const req = createRequire(import.meta.url);
      const { AsyncLocalStorage } = req("node:async_hooks") as { AsyncLocalStorage: new () => { run<R>(s: unknown, fn: () => R): R; getStore(): unknown } };
      return createNodeStorage(AsyncLocalStorage);
    } catch {
      // fall through to ponyfill
    }
  }
  return createPonyfillStorage();
}

type NodeRequire = (id: string) => { AsyncLocalStorage: new () => unknown };

let storageInstance: AsyncContextStorage<unknown> | null = null;

function getStorage(): AsyncContextStorage<unknown> {
  storageInstance ??= loadStorage();
  return storageInstance;
}

/**
 * Single async-context storage instance: native AsyncLocalStorage in Node when available,
 * ponyfill otherwise (e.g. browser). Tree-shakeable: node:async_hooks is only loaded via
 * dynamic require inside loadStorage(), so bundlers can avoid including it for browser.
 * @internal
 */
export const storage = getStorage();
