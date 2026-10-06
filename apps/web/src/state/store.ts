import { useSyncExternalStore } from "react";

/** A tiny observable value, read in React with `useStore`. */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private current: T) {}

  get value(): T {
    return this.current;
  }

  set(next: T | ((prev: T) => T)): void {
    this.current = typeof next === "function" ? (next as (prev: T) => T)(this.current) : next;
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.value, () => store.value);
}
