/** Shared facts for status tools, command output and the session projection. */
import { leafUnits, nextUnit } from './plan.mjs'
import { taskEvidenceView } from './task.mjs'
import { recordWaiting } from './task-record.mjs'
import { effectiveMode } from './mode.mjs'

export function planProgress(units = [], ledger = []) {
  const leaves = leafUnits(units)
  const done = leaves.filter(unit => unit.state === 'done').length
  return leaves.length ? { done, total: leaves.length, label: `${done}/${leaves.length}` }
    : { done: ledger.length, total: ledger.length, label: '无计划' }
}

export function taskStatus(task, plan, decisions = []) {
  const normalizedPlan = { ...plan, units: Array.isArray(plan?.units) ? plan.units : [] }
  return {
    task: { id: task.id, mode: task.mode, effectiveMode: effectiveMode(task.mode), state: task.state,
      request: task.request, goal: task.goal, scope: task.scope, project: task.project,
      ...taskEvidenceView(task, plan), acceptanceMode: task.acceptanceMode === 'auto' ? 'auto' : 'pm',
      hasReceipt: Boolean(task.receipt), auto: task.auto === true, goalRevision: (task.goalHistory ?? []).length,
      ...((task.goalHistory ?? []).length > 1 ? { goalHistory: task.goalHistory.slice(0, -1).map(row => row.text) } : {}) },
    progress: planProgress(normalizedPlan.units, task.ledger),
    current: nextUnit(normalizedPlan) ?? null,
    pending: recordWaiting(task),
    lastLedger: task.ledger?.at(-1),
    waiting: decisions.filter(row => !row.granted).map(row => ({ kind: row.kind, reason: row.reason })),
  }
}
