/**
 * Interface work, declared instead of generalised.
 *
 * The plugin does not know how a project tests its screens, and a "framework" for
 * that question would be a promise it cannot keep. What it can do is hold three
 * tiers still, and ask for the highest one a unit actually needs:
 *
 *   static   it parses and type-checks (a screen that does not compile is not done)
 *   logic    the project's own tests run (a guard, a formatter, a store)
 *   browser  something drove a browser and recorded a picture
 *
 * Three rules keep this small:
 *   1. declared on the unit (`ui: 'browser' | 'logic' | 'static' | false`), never
 *      on the task or the profile;
 *   2. checked at submit only — never before the work, so a small change does not
 *      wait behind a suite nobody can run;
 *   3. the higher tier covers the lower: a browser run satisfies a `logic` unit.
 *
 * Nothing here reads the project to decide what is "enough"; it reads the project
 * only to pick a default command for the tier the unit asked for.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evidenceCommand, executionFailed } from './session-log.mjs'

export const UI_TIERS = ['static', 'logic', 'browser']

const RANK = { static: 1, logic: 2, browser: 3 }

/** One command per tier. A project that tests differently overrides it on the unit. */
export const UI_CHECKS = {
  static: { name: '类型/语法', command: 'npx tsc --noEmit' },
  logic: { name: '逻辑测试', command: 'npm test' },
  browser: { name: '浏览器走一遍', command: 'npx playwright test' },
}

const SCREEN_WORDS = /界面|页面|按钮|样式|前端|截图|交互|\bui\b|\bhtml\b/i
const SCREEN_FILES = /\.(tsx|jsx|vue|svelte|html|css|scss|sass)$|(^|\/)(public|static|components|pages|views)\//i

/** Does this unit touch something a person looks at? */
export function touchesScreen(unit) {
  const words = `${unit?.goal ?? ''} ${unit?.deliverable ?? ''}`
  if (SCREEN_WORDS.test(words)) return true
  return (unit?.scope ?? []).some(path => SCREEN_FILES.test(String(path)))
}

/** Which tier the project can actually run, highest first. */
export function projectTier(project) {
  let scripts = {}
  try {
    const file = join(project ?? '.', 'package.json')
    if (existsSync(file)) scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {}
  } catch {
    scripts = {}
  }
  if (scripts['test:ui'] || scripts['test:e2e'] || existsSync(join(project ?? '.', 'playwright.config.ts')) || existsSync(join(project ?? '.', 'playwright.config.js'))) return 'browser'
  if (scripts.test) return 'logic'
  return 'static'
}

/**
 * The tier this unit owes. `ui: false` opts out; a tier string is taken as said;
 * otherwise a unit that touches a screen inherits the project's own capability.
 */
export function uiNeed(unit, project) {
  const said = unit?.ui
  if (said === false) return undefined
  if (typeof said === 'string' && UI_TIERS.includes(said)) return { tier: said, why: '单元上写明了' }
  if (!touchesScreen(unit)) return undefined
  return { tier: projectTier(project), why: '界面单元，按项目能力取默认档' }
}

/** The highest tier visible among these runs, or undefined when none ran. */
export function observedTier(rows) {
  let best
  for (const row of Array.isArray(rows) ? rows : []) {
    if (executionFailed(row)) continue
    const command = evidenceCommand(row.command)
    if (!command) continue
    for (const run of command.split('&&').map(part => part.trim())) {
      const direct = run.replace(/^(?:(?:npx|pnpm exec|yarn exec|bunx|npm run|pnpm run|yarn run|bun run)\s+)?(?:\S+\/)?/i, '')
      let tier
      if (/^(?:playwright|puppeteer|cypress|webdriver|chrome|chromium)\b/i.test(direct)) tier = 'browser'
      else if (/^(?:tsc|check-types|typecheck|type-check)\b/i.test(direct)) tier = 'static'
      else if (/^(?:vitest|jest|mocha)\b/i.test(direct) || /^(?:npm|pnpm)\s+(?:run\s+)?test\b/i.test(run)) tier = 'logic'
      if (tier && (!best || RANK[tier] > RANK[best])) best = tier
    }
  }
  return best
}

/**
 * What this submission is missing, if anything. Called at submit; returns
 * undefined when the unit owes nothing or the evidence already clears its tier.
 */
export function uiMissing({ unit, project, rows }) {
  const need = uiNeed(unit, project)
  if (!need) return undefined
  const got = observedTier(rows)
  if (got && RANK[got] >= RANK[need.tier]) return undefined
  return {
    tier: need.tier,
    why: need.why,
    observed: got,
    check: UI_CHECKS[need.tier],
  }
}
