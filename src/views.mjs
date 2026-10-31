/**
 * What a task looks like from outside: the plan rows, the board, the status a
 * tool returns, and the checks a plan has to pass before it is stored. Reads only;
 * the one record these consult beyond their arguments is the project timeline.
 */
import { taskStatus } from './status.mjs'
import { MEMORY_FILE, readMemory } from './memory.mjs'
import { flattenUnits, groupsOf, leafUnits, nextUnit, normalizeUnits, runnableUnits, validateUnits } from './plan.mjs'
import { detectVerifier } from './detect.mjs'

export function createViews({ records, timelineForProject }) {
  const checkpointView = task => {
    const rows = [...(task.checkpoints ?? [])]
    const latest = rows.length ? rows[rows.length - 1] : undefined
    const before = [...rows].reverse().find(row => row.tag === 'before')
    return {
      count: rows.length,
      ...(latest ? { latest: { ref: latest.ref, commit: latest.commit, seq: latest.seq, at: latest.at } } : {}),
      ...(before ? { before: { ref: before.ref, commit: before.commit, at: before.at } } : {}),
      ...(task.checkpointSkipped ? { skipped: task.checkpointSkipped } : {}),
    }
  }

  function gatesFor(mode) {
    return mode === 'look'
      ? { evidence: false, scope: false, authorization: false, plan: false }
      : { evidence: true, scope: true, authorization: true, plan: false }
  }

  /**
   * Refuse a plan that cannot be scheduled, before its task exists.
   *
   * `validateUnits` is the same gate `setUnits` applies later; calling it early is
   * what keeps a rejected `work_start` from leaving an active task with no units.
   */
  function assertPlan(units) {
    validateUnits(units ?? [])
    return true
  }

  /**
   * What a plan turned into: the ordered units and the command that proves them.
   * A unit without a detectable verifier is still runnable — the model may know a
   * check this file cannot see — but the report says so instead of implying a check
   * exists.
   */
  /**
   * What the plan compiled to, counted after flattening. Counting the declared
   * top level instead reported a two-milestone plan as `milestones: 0` and
   * `order: ["m1","m2"]`, which reads like the leaves were lost.
   */
  function compileReport(project, units) {
    const verifier = detectVerifier(project)
    const flat = flattenUnits(units)
    const leaves = leafUnits(flat)
    const order = validateUnits(flat)
    return {
      units: flat.length,
      leaves: leaves.length,
      milestones: flat.length - leaves.length,
      order,
      ...(verifier ? { verifier } : {}),
      unresolved: verifier ? [] : leaves.map(unit => unit.id),
    }
  }

  function planView(task, plan) {
    if (!plan) return { taskId: task.id, plan: null }
    const verifier = detectVerifier(task.project)
    const order = validateUnits(plan.units)
    return {
      taskId: task.id, planId: plan.id,
      // The version is derived, not maintained: how many goal sentences there
      // have been. A model that only rephrases leaves it alone.
      goalRevision: (task.goalHistory ?? []).length,
      ...((task.goalHistory ?? []).length > 1 ? { goalHistory: (task.goalHistory ?? []).slice(0, -1).map(row => row.text) } : {}),
      units: plan.units.map(unit => ({
        id: unit.id, goal: unit.goal, state: unit.state ?? 'pending', dependsOn: unit.dependsOn ?? [], scope: unit.scope, acceptance: unit.acceptance,
        // The newest progress note, so `work_plan list` shows the line the model
        // just wrote instead of pretending it vanished.
        ...(Array.isArray(unit.notes) && unit.notes.length ? { note: unit.notes[unit.notes.length - 1].text } : {}),
        ...(unit.parent ? { parent: unit.parent } : {}),
        ...(unit.role ? { role: unit.role } : {}),
        // The two marks the panel draws on a row: what it hands over, and whether
        // it is waiting on the person. `work_status view=board` promises "what the
        // panel shows", so they travel with the row, not only in the projection.
        ...(typeof unit.deliverable === 'string' && unit.deliverable.trim() !== '' ? { deliverable: unit.deliverable.trim() } : {}),
        ...(typeof unit.asked?.question === 'string' && unit.asked.question.trim() !== '' ? { asked: unit.asked.question.trim() } : {}),
        ...(verifier ? { verifier: verifier.command } : {}),
      })),
      milestones: groupsOf(plan.units).filter(group => group.units.length > 1 || group.units[0]?.parent),
      runnable: runnableUnits(plan.units).map(unit => unit.id),
      nextUnit: nextUnit(plan, order),
    }
  }

  function nextUnitAfter(plan, unitId) {
    if (!plan) return undefined
    const projected = plan.units.map(unit => unit.id === unitId ? { ...unit, state: 'done' } : unit)
    return nextUnit({ ...plan, units: projected })
  }

  /**
   * The leaf a unit id means. Milestones are containers with no work of their own, so
   * naming one means its active leaf, else its next unfinished one, else its first.
   */
  function leafOf(plan, unitId) {
    const unit = plan.units.find(entry => entry.id === unitId)
    const children = plan.units.filter(entry => entry.parent === unitId)
    if (!unit || children.length === 0) return unit
    const open = children.filter(child => !['done', 'dropped'].includes(child.state))
    return leafOf(plan, (open.find(child => child.state === 'active') ?? open[0] ?? children[0]).id)
  }

  function boardView(task, plan, decisions) {
    return {
      ...taskStatus(task, plan, decisions),
      // One mapping for rows: the panel draws what the plan says, and this view
      // has to be the same thing or "what the panel shows" is a second truth.
      units: planView(task, plan).units ?? [],
      milestones: planView(task, plan).milestones ?? [],
      // The pairs of saves the panel draws as 前/后 dots.
      marks: (task.checkpoints ?? []).map(row => ({ seq: row.seq, tag: row.tag, ...(row.unit ? { unit: row.unit } : {}), ...(row.label ? { label: row.label } : {}), ...(row.outcome ? { outcome: row.outcome } : {}) })),
      // The project's task history, newest first, current task flagged. The tool
      // view and the panel must show the same history or "what happened before"
      // becomes two different answers depending on who is asking.
      timeline: timelineForProject(task.project, task.id),

    }
  }

  function statusView(task, plan, decisions = records.all('decisions', row => row.taskId === task.id)) {
    const board = boardView(task, plan, decisions)
    const memory = readMemory(task.project)
    return { ...board, ...(plan ? planView(task, plan) : {}),
      clarify: task.clarify ? { asked: (task.clarify.asked ?? []).length,
        answered: (task.clarify.answers ?? []).length, assumption: task.clarify.assumption ?? null } : null,
      ledger: task.ledger ?? [], checkpoints: checkpointView(task),
      memory: { path: MEMORY_FILE, facts: memory.facts.length, incidents: memory.incidents.length },
      decisions: decisions.map(row => ({ kind: row.kind, granted: row.granted, risk: row.risk, at: row.at })),
    }
  }

  return { checkpointView, gatesFor, assertPlan, compileReport, planView, nextUnitAfter, leafOf, boardView, statusView }
}
