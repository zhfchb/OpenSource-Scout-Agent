import type Database from 'better-sqlite3';
// Shared by every executor using this database handle, including fixture applications.
export class ExecutionSlot {
  private owner?: symbol;
  private listeners = new Set<() => void>();
  get busy() { return Boolean(this.owner); }
  wake() {setImmediate(() => {for(const listener of this.listeners)listener();});}
  acquire() {
    if (this.owner) return undefined;
    const token = Symbol(); this.owner = token;
    return () => {
      if (this.owner !== token) return;
      this.owner = undefined;
      setImmediate(() => { for (const listener of this.listeners) listener(); });
    };
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
const slots = new WeakMap<Database.Database, ExecutionSlot>();
export function executionSlot(db: Database.Database) {
  let slot = slots.get(db); if (!slot) { slot = new ExecutionSlot(); slots.set(db, slot); } return slot;
}
