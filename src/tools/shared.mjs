/**
 * Schema pieces and plan helpers the work_* tools share.
 */
import { DOMAIN_SECTIONS, readDomain } from '../domain.mjs'
import { browserRunOf, text } from '../task.mjs'
import { craftHints } from '../craft.mjs'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { relatedRows } from '../memory.mjs'

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



/**
 * Say it, do not refuse it: a plan of six or more units that never nests is
 * usually several themes flattened into one list, and the model can fix that in
 * one call. Refusing would be the old control plane coming back through the side
 * door — the shape is a judgement, the warning is the cheap correction.
 */
/**
 * A theme is a container: a unit some other unit hangs under. The panel draws it as
 * a card, and the stream says when one is opened or closed — but the model never
 * has to call a "theme" tool, because a theme is only a unit with children.
 */
/**
 * A few lines of the project's own vocabulary, for the moment a task opens.
 *
 * The file stays the source of truth and the model may still read it; this is the
 * part worth putting in front of it unasked, the same way the memory digest goes
 * out: one line beats guessing what "回血包" means.
 */
export function domainBrief(project, query = '') {
  try {
    const { path, entries } = readDomain(project)
    const rows = ['term', 'rule', 'decision'].flatMap(kind => (entries[kind] ?? []).map(entry => ({ ...entry, kind })))
    const lines = relatedRows(rows, { query, limit: 3, text: entry => `${entry.key ?? ''} ${entry.text}` })
      .map(entry => `${DOMAIN_SECTIONS[entry.kind]} · ${entry.key ? `${entry.key}：` : ''}${entry.text}`.slice(0, 90))
    return lines.length ? { domain: { path, lines } } : {}
  } catch {
    return {}
  }
}

/**
 * Does this unit touch something a person looks at? Scope is the honest signal
 * (a .tsx/.html/.css file, a public/ directory); the words cover the case where
 * the model wrote "导出按钮" with a vague scope.
 */
export function touchesScreen(unit, task) {
  const words = `${unit?.goal ?? ''} ${task?.goal ?? ''}`
  if (/界面|页面|按钮|样式|前端|截图|\bui\b|\bhtml\b/i.test(words)) return true
  return (unit?.scope ?? []).some(path => /\.(tsx|jsx|vue|svelte|html|css|scss)$|public\/|static\//.test(String(path)))
}

/**
 * Evidence that a screen was actually looked at: a screenshot path on a claim, or
 * a run whose command drove a browser. Not "I checked it by eye" — that is what
 * the person does, not what the model can prove.
 */
export function browserEvidence(args, observations, project) {
  const claims = Array.isArray(args?.claims) ? args.claims : []
  const shots = []
  for (const claim of claims) {
    const text = `${claim?.statement ?? ''} ${claim?.files ?? ''} ${claim?.path ?? ''}`
    shots.push(...(text.match(/[^\s"'（）()，,]+?\.(?:png|jpe?g|webp|gif)\b/gi) ?? []))
  }
  // A path is evidence only if there is a file behind it: "outputs/click.png" in
  // a sentence proves nothing when the run only type-checked.
  if (shots.some(shot => existsSync(isAbsolute(shot) ? shot : join(project ?? '.', shot)))) return true
  const rows = Array.isArray(observations?.results) ? observations.results : []
  return rows.some(row => browserRunOf(row))
}

/**
 * Does this request touch something a person looks at? Same signals as the submit
 * warning, applied earlier: at the moment the task opens, when a model still reads.
 */
/**
 * What "it has a screen, so test it" means as an instruction rather than a wish:
 * which command opens the app (when the project recorded one), which command drives
 * the browser, and where the pictures go. A model that cannot tell how reads past
 * "run Playwright".
 */
export function uiTestLine(env) {
  const start = (env?.facts ?? []).find(fact => fact.kind === 'start')?.value
  const run = (env?.gui ?? [])[0]?.playwright ?? 'npx playwright test --headed'
  return `涉及界面：起服务${start ? `（${start}）` : '，命令记在 .auto-dev/runtime.json 的 facts.start'}，用非 headless 的 Playwright 跑一遍（${run}），截图放 outputs/，路径写进 claims；确实跑不了就在 summary 里写明只能人工看（v3 默认）`
}

export function looksLikeScreen({ goal = '', scope = [] } = {}) {
  if (/界面|页面|按钮|样式|前端|截图|\bui\b|\bhtml\b/i.test(String(goal))) return true
  return (Array.isArray(scope) ? scope : []).some(path =>
    /\.(tsx|jsx|vue|svelte|html|css|scss)$|public\/|static\//.test(String(path)))
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
 * 键与 craftHints 返回的 doc 路径一致；查不到的文档退回原名，不猜。
 */
export const CRAFT_MODES = Object.freeze({
  'references/craft/impact.md': '重构',
  'references/craft/verification.md': '验证',
  'references/craft/gui.md': '界面测试',
  'references/craft/release.md': '发布',
  'references/craft/debug.md': '排查',
  'references/craft/delivery.md': '分批交付',
  'references/craft/memory.md': '沉淀',
  'references/craft/review.md': '自查',
  'references/craft/bdd.md': '场景',
  'references/craft/interview.md': '澄清',
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
  const containers = new Set(rest.map(row => row.parent).filter(Boolean))
  const orphans = rest.filter(row => !row.parent && !containers.has(row.id))
  if (!held && orphans.length === 0) return rows
  const bucket = { ...DAILY_UNIT, ...(held ?? {}), role: 'daily' }
  return [bucket, ...rest.map(row => (row.parent ? row : { ...row, parent: DAILY_UNIT.id }))]
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
  if (plan === undefined || plan === null) return null
  const units = Array.isArray(plan) ? plan : (Array.isArray(plan?.units) ? plan.units : null)
  if (!units || units.length === 0) {
    throw new Error('plan must be a non-empty array of units, or {units: [...]} — each unit needs id, goal, scope and acceptance')
  }
  return units
}
