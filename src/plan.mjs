import { UI_TIERS } from './uicheck.mjs'

/**
 * A plan is a DAG of units, and a unit may contain units — that is what a
 * milestone is. There is no separate "compile" step: the host walks the tree,
 * finds the leaves that can start, and refuses a plan that lost a unit, hid a
 * cycle, or pointed a dependency at nothing. Everything else about a plan (how
 * many units, how deep, what they contain) stays the model's judgement.
 *
 * One rule worth stating because it is not obvious: a milestone is only done
 * when every unit inside it is done, and its state is derived, never stored. So
 * no plan can report "milestone 2 finished" while its leaves are still pending.
 */

export const UNIT_STATES = ['pending', 'active', 'done', 'blocked', 'dropped']

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Walk the tree and return a flat list, parents before children, each row
 * carrying `parent` and `depth`. Nested input and flat input both work, so a
 * model that writes one long list and a model that writes milestones produce
 * the same plan.
 */
export function flattenUnits(units, parent = null, depth = 0, out = []) {
  if (!Array.isArray(units)) throw new Error('a plan needs an array of units')
  for (const [index, unit] of units.entries()) {
    if (!unit || typeof unit !== 'object') throw new Error(`unit ${index + 1}${parent ? ` of "${parent}"` : ''} is not an object`)
    if (unit.units !== undefined) {
      if (!Array.isArray(unit.units)) throw new Error(`unit "${unit.id}" has a units field that is not an array`)
      if (unit.units.length === 0) throw new Error(`unit "${unit.id}" contains no units: a milestone with no work is a note, not a unit`)
    }
    // Drop the nested children from the flat row: the walk already emitted them,
    // and a leftover `units: undefined` would travel into tool output, which the
    // host refuses as not-lossless JSON.
    const row = { ...unit }
    delete row.units
    // Re-flattening flat rows must change nothing: `validateUnits` flattens its
    // input, and callers legitimately hand it already-normalized units (a
    // milestone's `parent` would otherwise be overwritten with null and the
    // milestone would be judged as a leaf that forgot its scope).
    out.push({ ...row, parent: unit.parent ?? parent, depth: unit.depth ?? depth })
    if (Array.isArray(unit.units)) flattenUnits(unit.units, unit.id, depth + 1, out)
  }
  return out
}

export function validateUnits(input) {
  const units = flattenUnits(input)
  if (units.length === 0) throw new Error('a plan needs at least one unit')
  const ids = new Set()
  for (const [index, unit] of units.entries()) {
    const id = unit.id
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new Error(`unit ${index + 1} needs an id of letters, digits, dot, underscore or hyphen`)
    }
    if (ids.has(id)) throw new Error(`unit id "${id}" is used twice: a plan identifies units by id`)
    ids.add(id)
    if (typeof unit.goal !== 'string' || unit.goal.trim() === '') throw new Error(`unit "${id}" needs a goal`)
    // `deliverable` is what a person would be shown when this unit lands: it is
    // optional, but an empty one is worse than none — it marks a unit as one that
    // promises something a person can look at
    // and then cannot name it.
    if (unit.deliverable !== undefined
      && (typeof unit.deliverable !== 'string' || unit.deliverable.trim() === '')) {
      throw new Error(`unit "${id}" has an empty deliverable: name what a person would see, or leave the field out`)
    }
    // A milestone holds work rather than doing it: its scope is what its leaves
    // touch and its acceptance is their acceptance, so demanding them again is
    // the same rule stated twice — and the second statement is the one a person
    // gets wrong.
    const isMilestone = units.some(candidate => candidate.parent === id)
    if (!isMilestone) {
      if (!Array.isArray(unit.scope) || unit.scope.length === 0) throw new Error(`unit "${id}" needs a non-empty scope`)
      if (!Array.isArray(unit.acceptance)) throw new Error(`unit "${id}" needs an acceptance array (it may be empty)`)
    }
  }
  const parentOf = new Map(units.filter(unit => unit.parent).map(unit => [unit.id, unit.parent]))
  const ancestorOf = id => {
    const chain = []
    let cursor = parentOf.get(id)
    while (cursor) { chain.push(cursor); cursor = parentOf.get(cursor) }
    return chain
  }
  for (const unit of units) {
    const ancestors = new Set(ancestorOf(unit.id))
    const descendants = new Set(units.filter(candidate => ancestorOf(candidate.id).includes(unit.id)).map(candidate => candidate.id))
    for (const dependency of unit.dependsOn ?? []) {
      if (dependency === unit.id) throw new Error(`unit "${unit.id}" depends on itself`)
      if (!ids.has(dependency)) throw new Error(`unit "${unit.id}" depends on unknown unit "${dependency}"`)
      // Both shapes below deadlock without any cycle in the declared graph: a
      // milestone already waits for the units it holds, so asking it to wait for
      // one of them (or asking a unit to wait for the milestone that holds it)
      // can never be satisfied. The walk below would not see it as a cycle.
      if (descendants.has(dependency)) {
        throw new Error(`unit "${unit.id}" depends on "${dependency}", which is inside it: a milestone already waits for the units it contains`)
      }
      if (ancestors.has(dependency)) {
        throw new Error(`unit "${unit.id}" depends on "${dependency}", which contains it: a unit cannot wait for the milestone it belongs to`)
      }
    }
  }
  for (const unit of units) {
    if (unit.ui !== undefined && unit.ui !== false && !UI_TIERS.includes(unit.ui)) {
      throw new Error(`unit "${unit.id}" has ui "${unit.ui}": use one of ${UI_TIERS.join(' | ')} or false`)
    }
  }
  const order = topologicalOrder(units)
  if (order.length !== units.length) {
    const stuck = units.map(unit => unit.id).filter(id => !order.includes(id))
    throw new Error(`the plan has a dependency cycle among: ${stuck.join(', ')} — a unit can only start after its dependencies are done`)
  }
  return order
}

/**
 * Kahn's algorithm over the flat list. Counting the walked nodes against the
 * input is the part that catches a cycle reachable from a root: a plan with one
 * independent unit plus a two-unit cycle still has a zero-in-degree start, so
 * "no zero in-degree node" alone would pass it.
 */
export function topologicalOrder(units) {
  const flat = units.some(unit => unit.units !== undefined) ? flattenUnits(units) : units
  const remaining = new Map(flat.map(unit => [unit.id, new Set(unit.dependsOn ?? [])]))
  const order = []
  let progressed = true
  while (progressed) {
    progressed = false
    for (const [id, dependencies] of [...remaining]) {
      if (dependencies.size > 0) continue
      order.push(id)
      remaining.delete(id)
      progressed = true
      for (const set of remaining.values()) set.delete(id)
    }
  }
  return order
}

/** Leaves are the units somebody actually works in; milestones only hold them. */
export function leafUnits(units) {
  const parents = new Set(units.filter(unit => unit.parent).map(unit => unit.parent))
  return units.filter(unit => !parents.has(unit.id))
}

/** A dependency is satisfied by a done leaf or by a milestone whose leaves are all done. */
export function isDone(id, units, byId = new Map(units.map(unit => [unit.id, unit]))) {
  const unit = byId.get(id)
  if (!unit) return false
  const children = units.filter(candidate => candidate.parent === id)
  if (children.length > 0) return children.every(child => isDone(child.id, units, byId))
  return unit.state === 'done'
}

/** A leaf can start when its own dependencies and its ancestors' are done. */
export function runnableUnits(units) {
  const flat = units.some(unit => unit.units !== undefined) ? flattenUnits(units) : units
  const byId = new Map(flat.map(unit => [unit.id, unit]))
  const satisfied = id => isDone(id, flat, byId)
  const ancestorReady = unit => {
    let parent = unit.parent
    while (parent) {
      const row = byId.get(parent)
      if (!row) return true
      if ((row.dependsOn ?? []).some(dependency => !satisfied(dependency))) return false
      parent = row.parent
    }
    return true
  }
  return leafUnits(flat).filter(unit => ['pending', 'active'].includes(unit.state ?? 'pending')
    && (unit.dependsOn ?? []).every(satisfied)
    && ancestorReady(unit))
}

export function normalizeUnits(input) {
  validateUnits(input)
  return flattenUnits(input).map(unit => ({
    id: unit.id,
    goal: unit.goal.trim(),
    // A milestone holds units instead of naming paths, so it has no scope of its
    // own; `validateUnits` is the gate that decides when a scope is required.
    scope: [...new Set((unit.scope ?? []).map(String))],
    acceptance: (unit.acceptance ?? []).map(String),
    dependsOn: [...new Set(unit.dependsOn ?? [])],
    deliverable: unit.deliverable ?? undefined,
    // What kind of work the unit is. Only three values, because only three change
    // what the host asks for at submit time (see validateSubmission).
    kind: unit.kind === 'refactor' || unit.kind === 'verification' ? unit.kind : undefined,
    state: UNIT_STATES.includes(unit.state) ? unit.state : 'pending',
    // Progress notes survive a plan rewrite: `add` concatenates the old units and
    // normalizes the lot, so dropping `notes` here silently erased every
    // "here is what moved" line the moment a unit was appended.
    ...(Array.isArray(unit.notes) && unit.notes.length ? { notes: unit.notes.slice(-8) } : {}),
    ...(unit.parent ? { parent: unit.parent, depth: unit.depth } : {}),
    ...(unit.lane ? { lane: unit.lane } : {}),
    // The 日需 bucket is a role, not a label: callers must not have to compare the
    // goal string to know a container is the bucket.
    ...(unit.role ? { role: unit.role } : {}),
    ...(unit.asked ? { asked: unit.asked } : {}),
    // 界面单元欠哪一档测试，写在单元上；规则见 uicheck.mjs。
    ...(typeof unit.ui === 'string' || unit.ui === false ? { ui: unit.ui } : {}),
  }))
}

/**
 * The next unit to work in: an active leaf wins (somebody is in it), then the
 * first runnable leaf in plan order. `order` is the list `validateUnits`
 * returned, so "first" means first in the plan the model wrote, not first in a
 * map iteration.
 */
export function nextUnit(plan, order) {
  const runnable = runnableUnits(plan.units)
  if (!runnable.length) return undefined
  const active = runnable.find(unit => unit.state === 'active')
  if (active) return active
  if (!order) return runnable[0]
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...runnable].sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0))[0]
}

/**
 * Milestones grouped for a human: a root with children becomes one group whose
 * state is derived from the children. A flat plan comes back as one group per
 * unit, so callers never need two code paths.
 */
export function groupsOf(units) {
  const groups = []
  for (const root of units.filter(unit => !unit.parent)) {
    const children = units.filter(unit => unit.parent === root.id)
    if (children.length === 0) {
      groups.push({ id: root.id, label: root.goal, state: root.state ?? 'pending', units: [root], ...(root.role ? { role: root.role } : {}) })
      continue
    }
    // A container is done only when every child is; anything half-landed is still
    // in progress, even if no child happens to be active right now.
    const state = children.every(child => child.state === 'done')
      ? 'done'
      : children.some(child => child.state === 'active') || children.some(child => child.state === 'done')
        ? 'active' : (root.state ?? 'pending')
    // The bucket is a role, not a name: every view that groups a plan (tools,
    // panel, dock) has to be able to tell 日需 apart from a campaign theme.
    groups.push({ id: root.id, label: root.goal, state, units: children, ...(root.role ? { role: root.role } : {}) })
  }
  return groups
}
