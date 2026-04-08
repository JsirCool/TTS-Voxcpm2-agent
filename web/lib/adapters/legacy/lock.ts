/**
 * In-memory lock manager with three scopes (global / episode / chunk).
 */
import type {
  LockHandle,
  LockInfo,
  LockManager,
  LockScope,
} from "@/lib/ports";
import { LockBusyError } from "@/lib/ports";

function serialize(scope: LockScope): string {
  switch (scope.type) {
    case "global":
      return "global";
    case "episode":
      return `ep:${scope.episodeId}`;
    case "chunk":
      return `chunk:${scope.episodeId}:${scope.chunkId}`;
  }
}

export class InMemoryLockManager implements LockManager {
  private locks = new Map<string, LockInfo>();

  async acquire(scope: LockScope, owner: string): Promise<LockHandle> {
    // Any lock blocks when global is held
    const globalInfo = this.locks.get("global");
    if (globalInfo) throw new LockBusyError(scope, globalInfo);

    if (scope.type === "global") {
      // Global can't coexist with anything
      const first = this.locks.values().next();
      if (!first.done) throw new LockBusyError(scope, first.value);
    } else if (scope.type === "episode") {
      const epKey = `ep:${scope.episodeId}`;
      if (this.locks.has(epKey)) {
        throw new LockBusyError(scope, this.locks.get(epKey)!);
      }
      // Any chunk lock in same episode blocks episode lock
      for (const [k, v] of this.locks) {
        if (k.startsWith(`chunk:${scope.episodeId}:`)) {
          throw new LockBusyError(scope, v);
        }
      }
    } else {
      // chunk
      const epKey = `ep:${scope.episodeId}`;
      if (this.locks.has(epKey)) {
        throw new LockBusyError(scope, this.locks.get(epKey)!);
      }
      const key = serialize(scope);
      if (this.locks.has(key)) {
        throw new LockBusyError(scope, this.locks.get(key)!);
      }
    }

    const key = serialize(scope);
    const info: LockInfo = {
      scope,
      owner,
      acquiredAt: new Date().toISOString(),
    };
    this.locks.set(key, info);

    return {
      release: async () => {
        this.locks.delete(key);
      },
    };
  }

  async isBusy(scope: LockScope): Promise<boolean> {
    if (this.locks.has("global")) return true;
    if (scope.type === "global") {
      return this.locks.size > 0;
    }
    if (scope.type === "episode") {
      if (this.locks.has(`ep:${scope.episodeId}`)) return true;
      for (const k of this.locks.keys()) {
        if (k.startsWith(`chunk:${scope.episodeId}:`)) return true;
      }
      return false;
    }
    // chunk
    if (this.locks.has(`ep:${scope.episodeId}`)) return true;
    return this.locks.has(serialize(scope));
  }

  async list(): Promise<LockInfo[]> {
    return [...this.locks.values()];
  }
}
