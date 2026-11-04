import { UI_TIERS } from './uicheck.mjs'

/**
 * A plan is a DAG of units, and a unit may contain units — that is what a
 * milestone is. There is no separate "compile" step: the host walks the tree,
 * finds the leaves that can start, and repairs a plan that hid a cycle or
 * pointed a dependency at nothing (`digestUnits`). Everything else about a plan (how
 * many units, how deep, what they contain) stays the model's judgement.
 *
 * One rule worth stating because it is not obvious: a milestone is only done
 * when every unit inside it is done, and its state is derived, never stored. So
 * no plan can report "milestone 2 finished" while its leaves are still pending.
 */

export const UNIT_STATES = ['pending', 'active', 'done', 'blocked', 'dropped']

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** A list the model may have written as one string, one value or nothing at all. */
function strings(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\n|；|;/) : []
  return list.map(item => typeof item === 'string' ? item.trim() : typeof item === 'number' ? String(item) : '').filter(Boolean)
}

/** What a unit is called when the model gave it something other than a goal. */
function goalOf(unit) {
  for (const key of ['goal', 'title', 'name', 'text', 'description', 'summary', 'step', 'content', 'task']) {
    if (typeof unit[key] === 'string' && unit[key].trim()) return unit[key].trim()
  }
  return ''
}

/**
 * Walk the tree and return a flat list, parents before children, each row
 * carrying `parent` and `depth`. Nested input and flat input both work, so a
 * model that writes one long list and a model that writes milestones produce
 * the same plan. Whatever is not a unit (a bare string becomes a goal) is
 * dropped, and a unit without a usable id gets one, so its children can name it.
 */
/**
 * Where a call put its units. Models write a plan as `steps`, `tasks` or `items`
 * as often as `units`; an unread spelling silently emptied the plan (v27 #46).
 */
const UNIT_KEYS = ['units', 'steps', 'tasks', 'items', 'subtasks']
export const unitsIn = value => {
  if (Array.isArray(value) || typeof value === 'string') return value
  const key = UNIT_KEYS.find(name => Array.isArray(value?.[name]) || (name === 'units' && typeof value?.[name] === 'string'))
  return key ? value[key] : undefined
}

const declaredId = unit => {
  const raw = typeof unit?.id === 'number' ? String(unit.id) : unit?.id
  return typeof raw === 'string' && ID_PATTERN.test(raw.trim()) ? raw.trim() : undefined
}
/** Every id the model wrote anywhere in the tree: an id the plugin makes up must not take one (v56 clarify). */
const declaredIds = (units, into = new Set()) => {
  const found = unitsIn(units)
  for (const entry of Array.isArray(found) ? found : []) {
    if (!entry || typeof entry !== 'object') continue
    const id = declaredId(entry)
    if (id) into.add(id)
    declaredIds(unitsIn(entry), into)
  }
  return into
}

export function flattenUnits(units, parent = null, depth = 0, out = [], taken = declaredIds(units)) {
  const found = unitsIn(units)
  const list = Array.isArray(found) ? found : typeof found === 'string' && found.trim() ? [found] : []
  let index = 0
  for (const entry of list) {
    const unit = typeof entry === 'string' ? (entry.trim() ? { goal: entry.trim() } : undefined) : entry
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) continue
    index += 1
    // An unnamed child is named after its parent (u1.1, u1.2); an unnamed top row takes the next free u<n>.
    let id = declaredId(unit)
    if (!id) {
      let n = parent ? index : out.length + 1
      do { id = parent ? `${parent}.${n}` : `u${n}`; n += 1 } while (taken.has(id))
      taken.add(id)
    }
    // Drop the nested children from the flat row: the walk already emitted them,
    // and a leftover `units: undefined` would travel into tool output, which the
    // host refuses as not-lossless JSON.
    const row = { ...unit, id }
    const children = unitsIn(unit)
    for (const key of UNIT_KEYS) delete row[key]
    // Re-flattening flat rows must change nothing: `validateUnits` flattens its
    // input, and callers legitimately hand it already-normalized units (a
    // milestone's `parent` would otherwise be overwritten with null and the
    // milestone would be judged as a leaf that forgot its scope).
    out.push({ ...row, parent: unit.parent ?? parent, depth: unit.depth ?? depth })
    if (Array.isArray(children)) flattenUnits(children, id, depth + 1, out, taken)
  }
  return out
}

/**
 * Turn whatever the model wrote into a plan that can be scheduled: repair,
 * default or drop, never refuse (设计约定「门禁定义」— a plan's shape is not a
 * gate). Returns the flat units and one line per repair, for tests and notes.
 *
 * A duplicate id gets a suffix; a missing goal borrows title/name/text; a leaf
 * without scope works on the whole project ('.'); acceptance may be empty; a
 * dependency on itself, on nothing, or across its own milestone is dropped, and
 * a cycle is broken by dropping the dependencies among the units caught in it.
 */
export function digestUnits(input) {
  const units = flattenUnits(input)
  const fixed = []
  const ids = new Set()
  for (const unit of units) {
    if (ids.has(unit.id)) {
      let n = 2
      while (ids.has(`${unit.id}-${n}`)) n++
      fixed.push(`id ${unit.id} 重复，第二个改成 ${unit.id}-${n}`)
      unit.id = `${unit.id}-${n}`
    }
    ids.add(unit.id)
    const goal = goalOf(unit)
    if (!goal) fixed.push(`${unit.id} 没写目标`)
    // No goal is an empty goal: the panel names it by position, never by its id (v56 「单元 u2」).
    unit.goal = goal
    // A todo-list shape (`status: completed|in_progress`) is the same unit state in other words.
    if (!UNIT_STATES.includes(unit.state) && typeof unit.status === 'string') {
      const state = { completed: 'done', done: 'done', in_progress: 'active', active: 'active', pending: 'pending', blocked: 'blocked', cancelled: 'dropped', dropped: 'dropped' }[unit.status.trim().toLowerCase()]
      if (state) unit.state = state
    }
    // `deliverable` is what a person would be shown when this unit lands: an
    // empty one is worse than none, so it is left out.
    if (unit.deliverable !== undefined && (typeof unit.deliverable !== 'string' || unit.deliverable.trim() === '')) delete unit.deliverable
    // A milestone holds work rather than doing it: its scope is what its leaves
    // touch, so only a leaf gets the whole project when it names nothing.
    const isMilestone = units.some(candidate => candidate.parent === unit.id)
    const scope = strings(unit.scope)
    unit.scope = scope.length || isMilestone ? scope : ['.']
    unit.acceptance = strings(unit.acceptance)
    unit.dependsOn = strings(unit.dependsOn)
    if (unit.ui !== undefined && unit.ui !== false && !UI_TIERS.includes(unit.ui)) delete unit.ui
  }
  const parentOf = new Map(units.filter(unit => unit.parent).map(unit => [unit.id, unit.parent]))
  const ancestorOf = id => {
    const chain = []
    let cursor = parentOf.get(id)
    while (cursor && !chain.includes(cursor)) { chain.push(cursor); cursor = parentOf.get(cursor) }
    return chain
  }
  for (const unit of units) {
    // A milestone already waits for the units it holds, and a unit cannot wait
    // for the milestone holding it: both deadlock without a declared cycle.
    const ancestors = new Set(ancestorOf(unit.id))
    const kept = unit.dependsOn.filter(dependency => dependency !== unit.id && ids.has(dependency)
      && !ancestors.has(dependency) && !ancestorOf(dependency).includes(unit.id))
    if (kept.length !== unit.dependsOn.length) fixed.push(`${unit.id} 去掉了排不上的依赖：${unit.dependsOn.filter(id => !kept.includes(id)).join(', ')}`)
    unit.dependsOn = kept
  }
  const order = topologicalOrder(units)
  if (order.length !== units.length) {
    const stuck = new Set(units.map(unit => unit.id).filter(id => !order.includes(id)))
    for (const unit of units) if (stuck.has(unit.id)) unit.dependsOn = unit.dependsOn.filter(id => !stuck.has(id))
    fixed.push(`依赖成环，拆开了：${[...stuck].join(', ')}`)
  }
  return { units, fixed }
}

/** The unit ids in an order they can run, after `digestUnits` repaired the plan. */
export function validateUnits(input) {
  return topologicalOrder(digestUnits(input).units)
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
  return digestUnits(input).units.map(unit => ({
    id: unit.id,
    goal: unit.goal,
    // A milestone holds units instead of naming paths, so it has no scope of its
    // own; `digestUnits` gives a leaf the whole project when it names nothing.
    scope: [...new Set(unit.scope)],
    acceptance: unit.acceptance,
    dependsOn: [...new Set(unit.dependsOn)],
    deliverable: unit.deliverable ?? undefined,
    // What kind of work the unit is. refactor and verification change what the
    // host asks for at submit time (see validateSubmission); perf only picks the
    // method card. Optional, never a gate: an unknown or missing kind is delivery.
    kind: ['refactor', 'verification', 'perf', 'test', 'clarify'].includes(unit.kind) ? unit.kind : undefined,
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
