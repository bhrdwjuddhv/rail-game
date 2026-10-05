// Minimal typed observable store.
export class Store<T extends object> {
  private subs = new Set<(s: T) => void>();
  constructor(private state: T) {}
  get(): T { return this.state; }
  set(patch: Partial<T>) {
    this.state = { ...this.state, ...patch };
    for (const s of this.subs) s(this.state);
  }
  subscribe(fn: (s: T) => void) { this.subs.add(fn); return () => this.subs.delete(fn); }
}
