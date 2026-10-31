/**
 * One serialized owner over the DSH KV unit. The plugin owns four tables and
 * nothing else: `tasks` (one row per activation), `plans` (unit DAGs),
 * `decisions` (authorizations, overrides and capability extensions) and
 * `sessions` (the conversations that asked for Auto Dev). Evidence is never
 * stored here — it is resolved from the session log on demand, so a record can
 * never claim an execution that did not happen.
 */
import { invariant } from './gate.mjs'
export const TABLES = ['tasks', 'plans', 'decisions', 'sessions']

// Write order inside this process, stamped on the stored row itself. `updatedAt`
// has millisecond resolution and two changes in a row often share it; this is
// what says which came last. Keyed by the row, not by the store, so every reader
// of the same rows agrees.
const writeOrder = new WeakMap()
let writes = 0

export class Records {
  static async open(backend) {
    const unit = await backend.kv.open({
      name: 'dsh_auto_dev', version: 1, tables: TABLES,
      hasGlobal: false, layout: 'per-record',
    })
    try {
      const snapshot = await unit.loadAll()
      for (const table of TABLES) {
        // A backend that has never written a table may omit it entirely; an
        // absent table is empty, not malformed.
        for (const [id, row] of Object.entries(snapshot.tables?.[table] ?? {})) {
          invariant(row?.version === 1 && row.id === id && typeof row.project === 'string', `malformed ${table}/${id}`)
        }
      }
      return new Records(unit, snapshot.tables)
    } catch (error) { await unit.close(); throw error }
  }

  constructor(unit, tables) {
    this.unit = unit
    this.tables = { ...tables }
    for (const table of TABLES) if (!this.tables[table]) this.tables[table] = {}
    this.pending = Promise.resolve()
  }

  /** How recently this process wrote the row: higher is later, 0 is never. */
  written(table, id) { return writeOrder.get(this.tables[table][id]) ?? 0 }

  get(table, id) { return structuredClone(this.tables[table][id]) }
  /**
   * Copies of the rows, filtered first: `keep` runs on the stored rows, so only
   * what the caller asked for is cloned. Most reads want one project or one task.
   */
  all(table, keep) {
    const rows = Object.values(this.tables[table])
    return structuredClone(keep ? rows.filter(keep) : rows)
  }

  /**
   * Read-only views for hot paths. No clone: the projection reads its store on
   * every view call, and cloning the whole task table there would be work the
   * host pays per render. Treat what comes back as frozen.
   */
  peek(table) { return Object.values(this.tables[table]) }
  peekOne(table, id) { return this.tables[table][id] }

  change(table, id, update) {
    const run = this.pending.then(async () => {
      const before = this.get(table, id)
      const after = update(before)
      if (after === undefined) return before
      invariant(after.id === id && after.version === 1, 'invalid record identity/version')
      await this.unit.putRecord(table, id, after)
      const row = structuredClone(after)
      writeOrder.set(row, ++writes)
      this.tables[table][id] = row
      // `after` was built from a copy and is not what is stored: hand it back as is.
      return after
    })
    this.pending = run.catch(() => {})
    return run
  }

  async close() { await this.pending; await this.unit.close() }
}
