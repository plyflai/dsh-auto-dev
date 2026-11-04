/**
 * Schema pieces and plan helpers the work_* tools share.
 */
import { text } from '../task.mjs'
import { normalizeUnits } from '../plan.mjs'

export const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
export const string = { type: 'string' }
export const strings = { type: 'array', items: string }
export const claimsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      statement: { type: 'string' },
      command: { type: 'string' },
      execution: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
    },
    required: ['statement', 'execution'],
    additionalProperties: true,
  },
}








export function containersOf(units = []) {
  const parents = new Set(units.map(unit => unit.parent).filter(Boolean))
  return units.filter(unit => parents.has(unit.id))
}

export const childrenOf = (units, id) => units.filter(unit => unit.parent === id)


/**
 * The bucket every task has: the small work that belongs to no campaign theme.
 *
 * A plan with no themes is not flat on purpose — it is one bucket the panel can
 * only draw as a list. The bucket is created on the first write, so the shape is
 * the same from the first unit, and a campaign theme is opened *beside* it.
 */
/**
 * 文档是旧"模式"的落点，人看到的是"现在按什么做"，不是文件名。
 * 键是卡片上的 doc 路径；查不到的文档退回原名，不猜。
 */
export const CRAFT_MODES = Object.freeze({
  'references/craft/impact.md': '影响面',
  'references/craft/verification.md': '验证',
  'references/craft/test.md': '测试',
  'references/craft/gui.md': '界面测试',
  'references/craft/release.md': '发布',
  'references/craft/debug.md': '排查',
  'references/craft/delivery.md': '分批交付',
  'references/craft/memory.md': '沉淀',
  'references/craft/review.md': '自查',
  'references/craft/bdd.md': '场景',
  'references/craft/interview.md': '澄清',
  'references/craft/perf.md': '性能',
})

/** 整理动作给人看的说法：英文枚举不进人的眼睛。 */
export const STEP_WORD = Object.freeze({ group: '归组', rename: '改名', ungroup: '拆开' })

export const DAILY_UNIT = Object.freeze({ id: 'daily', goal: '日需', role: 'daily', state: 'pending', scope: [], acceptance: [] })

export function withDaily(units) {
  const rows = Array.isArray(units) ? units : []
  if (rows.length === 0) return rows
  const held = rows.find(row => row.id === DAILY_UNIT.id)
  const rest = rows.filter(row => row.id !== DAILY_UNIT.id)
  // A row that already holds units is a campaign theme, not a small action: it
  // stays at the top level even though nothing points at it.
  // A row that holds steps — named by its children's parent, or still nested as steps/units — is a theme.
  const nested = row => ['units', 'steps', 'tasks', 'items', 'subtasks'].some(key => Array.isArray(row?.[key]) && row[key].length)
  const containers = new Set([...rest.map(row => row.parent).filter(Boolean), ...rest.filter(nested).map(row => row.id).filter(Boolean)])
  const orphans = rest.filter(row => !row.parent && !containers.has(row.id))
  if (!held && orphans.length === 0) return rows
  const bucket = { ...DAILY_UNIT, ...(held ?? {}), role: 'daily' }
  // Only loose steps go in the bucket; a theme (a row that holds steps) stays at the root (v57 feature).
  return [bucket, ...rest.map(row => (row.parent || containers.has(row.id) || nested(row) ? row : { ...row, parent: DAILY_UNIT.id }))]
}

export function dailyWarning(view) {
  const rows = Array.isArray(view?.units) ? view.units : []
  const held = rows.filter(row => row.parent === DAILY_UNIT.id).length
  if (held <= 6) return undefined
  return `日需里已经堆了 ${held} 件小动作。如果其中几件其实是一条线，让用户跑一次 /dsh-auto-dev organize 体检，把该升格的那几件收成一个战役主题——不要自己动手重排。`
}

/**
 * Put existing units under one new container without touching them.
 *
 * "Add a theme later" is a cleanup, not a re-plan: the rows already carry state,
 * notes and evidence windows, and a `set` would make the model retype all of it.
 * This rebuilds only the parent links, then recomputes depth from them.
 */
export function groupUnder(units, theme, members) {
  const inside = new Set(members)
  const rows = units.map(row => inside.has(row.id) ? { ...row, parent: theme.id } : row)
  const byId = new Map([theme, ...rows].map(row => [row.id, row]))
  const depthOf = (row, guard = 0) => {
    const parent = row?.parent
    if (typeof parent !== 'string' || parent === '' || guard > 64) return 0
    return 1 + depthOf(byId.get(parent), guard + 1)
  }
  return [theme, ...rows].map(row => ({ ...row, depth: depthOf(row) }))
}

/** Read the units out of either accepted `plan` spelling; refuse the rest loudly. */
export function planUnits(plan) {
  const units = normalizeUnits(plan)
  // done is owned by a verified work_submit; an opening plan that says so starts pending.
  return units.length ? units.map(unit => unit.state === 'done' ? { ...unit, state: 'pending' } : unit) : null
}

/** What a step is called where a person reads it: its goal, else its position (records from older builds wrote 「单元 <id>」). */
export function shownGoal(units = [], unit) {
  const goal = String(unit?.goal ?? '').trim()
  return goal && !/^单元 \S+$/.test(goal) ? goal : stepName(units, unit?.id)
}

/**
 * How a person names a step: 「第 N 步」 in plan order, or 「<主题> · 第 k 步」 inside a theme.
 * Unit ids are for the model to point with; they never reach the card face or the panel.
 */
export function stepName(units = [], id) {
  const rows = (units ?? []).filter(unit => unit.id !== DAILY_UNIT.id && unit.role !== 'daily')
  const leaves = rows.filter(unit => !rows.some(other => other.parent === unit.id))
  const unit = rows.find(row => row.id === id)
  if (!unit) return '这一步'
  const parent = unit.parent ? rows.find(row => row.id === unit.parent) : undefined
  if (parent && parent.id !== DAILY_UNIT.id) {
    const siblings = leaves.filter(row => row.parent === parent.id)
    return `${parent.goal} · 第 ${siblings.indexOf(unit) + 1} 步`
  }
  const at = leaves.indexOf(unit)
  return at < 0 ? '这一步' : `第 ${at + 1} 步`
}

/** A theme's state from its steps: all done is done, any started is active, else what it says. One rule for board and timeline. */
export function themeState(children = [], own = 'pending') {
  if (children.length && children.every(child => child.state === 'done')) return 'done'
  if (children.some(child => child.state === 'active' || child.state === 'done')) return 'active'
  return own ?? 'pending'
}
