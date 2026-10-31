/**
 * Everything the plugin says to the model, and when (设计约定「第三条路」).
 *
 * The plugin opens its mouth at moments it can see without understanding:
 *   开工        — START: conditional sentences; whether one applies is the model's call.
 *   第一次写文件  — FIRST_WRITE: the 「动手前」 sentences, at the moment they are about.
 *   检查第 2 次红 — the fix card: the failing output verbatim and the last incidents.
 *   红后转绿      — the fixed card: write the incident down.
 *   文件消失仍被引用 — the deleted card: which files still say its name.
 *   交付        — DELIVERY: conditional sentences again.
 *   接手        — the handoff card: what the task's record holds, verbatim.
 * 「先量基线 / 先跑基线」 left after v33: the model had already done both before
 * its first write, and at that moment 「改之前」 is too late anyway.
 * Nothing here reads meaning out of a command, an output or a request. A card
 * that only repeats what the model would do anyway is not here (沉默测试).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INCIDENTS_FILE, recentIncidents, tailOf, trimmedCheck } from './facts.mjs'
import { DOMAIN_FILE } from './domain.mjs'
import { changedPaths, changedSinceStored, fingerprint, marksOf } from './disk.mjs'
import { spokeSinceStart } from './decisions.mjs'
import { teamConventions, teamIncidents } from './team.mjs'

/** Said once at start. Each is a condition the model checks against the person's words. */
export const START = Object.freeze([
  '如果用户要的是紧急止血：先最小改动止住症状，不扩范围。',
  '如果是补测试：测外部可见行为，至少一个失败或边界用例，照现有测试的写法；用户说只加测试就别改源码。',
  '如果是清理：删之前找引用，删完跑检查。',
  `如果用户只要你看、不要改：不写文件，结论写进 ${DOMAIN_FILE}。`,
])

/**
 * Said once, right after the task's first file-tool write (a structured path, not
 * shell text) — the moment 「动手前」 sentences are about. Said at start they drowned.
 */
export const FIRST_WRITE = Object.freeze([
  `如果这是提速：一次只改一处，改完用同一量法再量；没变快就回存档；交付写明热点、量法、前后数字，量法写进 ${DOMAIN_FILE}。`,
  '如果这是重构 / 提取 / 改名：删旧名前先找调用方；一小步一检查；交付时说哪些行为没变、怎么核对的。',
  '如果是新功能：先列计划（几步、每步怎么验），再往下写；每步做完跑一次项目检查。',
])
// A fixed shape for the restatement (v36 clarify: told to stop, the model went on): a
// format to follow, not a check — whether to restate at all is the model's call.
const ASK_FIRST = '如果需求有好几条或有含糊处、还没跟用户对过：先停下，对用户复述——第一行写「**我理解的要求：**」，下面逐条列要求和验收；有更省事的做法另起一行「**更省事的做法：**」讲清差别；最后只问一个最影响下一步的问题，然后结束这一回合等他回，别接着改。'

/** The check agreement: the two forms the plugin counts (src/facts.mjs exactCheck), nothing else. */
const checkAgreement = command => `跑就写 \`${command}\`；要截短输出就写 \`${trimmedCheck(command)}\`（必须带 set -o pipefail，tail 行数随意）。别的写法（不带 pipefail、head、cd、&&）插件不认，出错时就没法帮你排查和存档。`

/**
 * The person's start words cut at 。；; and line breaks, verbatim; the 验收 sentence is not a
 * request (v28 clarify counted it). A cut, not a reading: whether a sentence is a
 * separate requirement is the model's call, so the card says 句, not 条要求.
 */
export const requestSentences = request => String(request ?? '')
  .replace(/^\s*\/dsh-auto-dev(\s+start)?\s*/, '')
  .split(/[。；;\n]+/).map(part => part.trim())
  .filter(part => part.length > 1 && !/^(验收|acceptance)\s*[:：]/i.test(part))
const SCATTERED = 3

/**
 * The first-write card. `spoke`: the person has said something since the task started (a host fact).
 * `request`: their start words; three or more sentences and no word since go on the card verbatim,
 * so the restatement has the person's own words to work from (v37 clarify: 「没什么含糊的」).
 */
export function firstWriteCard(spoke, verifier, request) {
  const sentences = spoke ? [] : requestSentences(request)
  const quoted = sentences.length >= SCATTERED
    ? [`事实：开工原话断开是 ${sentences.length} 句，开工后用户还没说过话——${sentences.slice(0, 8).map(part => `「${part}」`).join('')}`]
    : []
  const lines = [...quoted, ...(spoke ? [] : [ASK_FIRST]), ...FIRST_WRITE]
  // The check agreement again, at the moment the next check is about to run (said at start it was not kept, v31).
  const check = verifier?.command ? `\n接下来跑项目检查：${checkAgreement(verifier.command)}` : ''
  return [`**刚改了第一个文件** — 都不适用就忽略：\n${lines.map(line => `- ${line}`).join('\n')}${check}`,
    'dsh-auto-dev first write', { form: 'read-doc', data: { title: '刚改了第一个文件', line: verifier?.command ? `检查写 ${verifier.command}` : '动手前的几件事', tag: '动手前', tone: 'info' } }]
}

/**
 * Said at hand-in: only lines with a hard fact behind them (a screen file changed, the
 * person never spoke, the person spoke, the domain file too long). The 提速 / 重构
 * delivery asks live in FIRST_WRITE: said to every flow at hand-in they made models
 * write 「都不适用」 paragraphs and empty 提速 sections (v34 test, v36 fix 沉默测试).
 */
export const DELIVERY = Object.freeze([])
// Only after the person said something since the start (a host fact): with no word
// from them there is no 口径 to keep, and the line sent models off writing a
// domain file of placeholders (v34 hotfix/test/fix).
const RULE_LINE = `如果这次用户定了口径或规则：写进 ${DOMAIN_FILE}。`
const SCREEN = /\.(tsx|jsx|vue|svelte|css|scss|html)$/i
const SCREEN_LINE = '如果改的是用户看得见的界面：交付前用浏览器真点一次、留截图。'

const domainText = (project, max = 1600) => {
  try {
    const text = readFileSync(join(project, DOMAIN_FILE), 'utf8').trim()
    return text.length > max ? `${text.slice(0, max)}\n…（全文见 ${DOMAIN_FILE}）` : text
  } catch { return '' }
}

/**
 * The start brief's lines after the person's words: the plain-check agreement,
 * the conditional sentences, and this project's incidents and domain verbatim.
 */
export function startLines(project, verifier) {
  const incidents = recentIncidents(project, 3)
  const domain = domainText(project)
  const team = teamIncidents(project, 3)
  const conventions = teamConventions()
  return [
    verifier?.command
      ? `项目检查是 \`${verifier.command}\`：${checkAgreement(verifier.command)}`
      : '',
    ...START,
    incidents ? `${INCIDENTS_FILE} 最近几条（原文）：\n${incidents}` : '',
    domain ? `${DOMAIN_FILE}（原文）：\n${domain}` : '',
    conventions ? `团队约定（用户写的原文；跟这个项目自己的约定冲突时，以项目为准）：\n${conventions}` : '',
    team.length ? `别的项目留下的复盘（各项目最新一条原文；跟这次像就参考，不像就忽略）：\n${team.map(row => `[${row.project}]\n${row.text}`).join('\n')}` : '',
  ].filter(Boolean)
}

/** The hand-in lines; `paths` are files the task changed on disk. */
/** Lines past which the domain file is asked to be merged down (大原则 8：有存就有退役). */
export const MAX_DOMAIN_LINES = 80

const UNCONFIRMED_LINE = '开工后用户还没说过话：如果需求有好几条或有含糊处，交付时逐条对照原话说你是怎么理解、怎么做的，没做的也说'

export function deliveryLines(paths = [], project, { spoke = true } = {}) {
  let size = 0
  try { size = readFileSync(join(project ?? '', DOMAIN_FILE), 'utf8').split('\n').filter(line => line.trim()).length } catch { /* no domain file */ }
  return [...DELIVERY, ...(paths.some(path => SCREEN.test(String(path))) ? [SCREEN_LINE] : []),
    // Hard fact: the person has not said a word since the start.
    ...(spoke ? [RULE_LINE] : [UNCONFIRMED_LINE]),
    ...(size > MAX_DOMAIN_LINES ? [`${DOMAIN_FILE} 已经 ${size} 行：如果有重复或过时的口径，合并或删掉，留下现在还成立的`] : [])]
}

/** The hand-in sentences said where the turn ended by itself: a capsule the person sees too (v34: form notice was hidden). */
export function deliveryCard(lines) {
  return [`交付前对照一下（只做适用的，不适用就直接结束）：\n${lines.map(line => `- ${line}`).join('\n')}`,
    'dsh-auto-dev delivery', { form: 'read-doc', data: { title: '交付前对照一下', line: `${lines.length} 条，只做适用的`, tag: '交付前', tone: 'info' } }]
}

/**
 * The hand-in sentences, once per task, whichever way the hand-in came (turn end or
 * a tool call, v36 feature/cleanup). The paths are a fingerprint diff, which leaves
 * out the plugin's own .auto-dev files: a task that changed nothing else hears none.
 */
export async function deliveryOnce(api, agent, task) {
  const key = `delivery:${task.id}`
  if (task.mode === 'look' || api.nudged.has(key)) return undefined
  const start = marksOf(task.id).start
  const paths = await changedPaths(task.project, start, start && await fingerprint(task.project))
  if (!paths.length) return undefined
  api.nudged.set(key, true)
  return deliveryCard(deliveryLines(paths, task.project, { spoke: spokeSinceStart(agent, task) }))
}

export const CARDS = Object.freeze({
  fix: {
    doc: 'references/craft/debug.md',
    title: '修 bug · 排查',
    brief: '同一检查红了第二次：按可能性逐个试',
    line: '先列 2–4 个最可能的方向，按可能性排序，从最可能的开始逐个用最便宜的办法证实或排除，排除了记一句再试下一个；可回「修前」档。如果这些红是你有意写的测试，忽略这张。',
  },
  fixed: {
    doc: 'references/craft/debug.md',
    title: '修通 · 记一笔',
    brief: `红过之后转绿：写进 ${INCIDENTS_FILE}`,
    line: `如果刚修好的是个 bug，把症状、试过的方向（哪些排除了、为什么）、根因、修法、验证命令写进 ${INCIDENTS_FILE}，格式不限。如果这些红是有意的，在那里写一行「有意的红」。`,
  },
  deleted: {
    doc: 'references/craft/impact.md',
    title: '删除 · 还有引用',
    brief: '删掉的东西仓库里还有人在用',
    line: '逐个确认：一起改、换入口或撤回删除，改完跑检查。',
  },
})

/** `[body, summary, options]` for api.notice / api.queueNotice. */
export function craftCard(key, { unit, facts = [] } = {}) {
  const page = CARDS[key]
  const body = [...facts.filter(Boolean).map(line => `事实：${line}`), `方法：${page.line}`, `参考：${page.doc}`].join('\n')
  return [body, `dsh-auto-dev method ${key}`, { form: 'read-doc', data: { unit: unit?.id ?? '', title: page.title, line: page.brief, tag: page.doc, tone: 'info' } }]
}

/** The second red of the project's check in a row. */
export const fixCard = (unit, reds, project) => craftCard('fix', {
  unit,
  facts: [
    `\`${reds.at(-1).command}\` 连续第 ${reds.length} 次退出码非 0，最后一次输出末尾：\n${tailOf(reds.at(-1).output, 20)}`,
    recentIncidents(project, 3) ? `${INCIDENTS_FILE} 最近几条（原文）：\n${recentIncidents(project, 3)}` : '',
  ],
})

/** A pass after two or more reds. */
export const fixedCard = (unit, fix) => craftCard('fixed', {
  unit,
  facts: [`\`${fix.green.command}\` 红了 ${fix.reds.length} 次之后退出码 0`],
})

/** Files that vanished from disk while other files still say their name. */
export const deletedCard = (unit, refs) => craftCard('deleted', {
  unit,
  facts: [...new Set(refs.map(row => row.name))].map(name =>
    `这些文件里还出现「${name}」：${refs.filter(row => row.name === name).slice(0, 6).map(row => row.file).join('、')}`),
})

/** The hand-in moment when a person must look: one card, whichever path handed in. */
export const reviewCard = task => [
  `**做完了 · 要不要看一眼？** — ${String(task.goal || task.request || '这次交付').replace(/[。.\s]+$/, '')}。停下来等用户：说「可以」就收案，说哪里不对就退回改，说别的就什么都别做，不要追问他。`,
  'dsh-auto-dev review ask',
  { form: 'review', data: { unit: task.id, title: '做完了 · 要不要看一眼？', line: '可以 / 再来一轮 / 先放这儿', tag: '回一句就行', tone: 'done' } },
]

const HANDOFF_LINE = '如果你不记得前面的过程：从这些事实接着做，先看改过的文件和最后一次检查，别从头重来；跟原话对不上的地方问用户。'

/**
 * The handoff card (另一个会话接手): the task's record read back — the start words,
 * the person's later words, the last plain run of the check with its exit status,
 * the files changed since the start tree, the saves. A line with no fact is left
 * out, never turned into a "not": no record of a plain check run does not mean no
 * check ran (v40: `cd … && npm test` is not the plain command).
 */
export async function handoffCard(task, { from } = {}) {
  const trail = task.trail ?? {}
  const changed = trail.start ? await changedSinceStored(task.project, trail.start) : undefined
  const saves = (task.checkpoints ?? []).slice(-4)
  const facts = [
    `开工原话：「${String(task.request ?? '').trim()}」`,
    trail.said?.length ? `之后用户说过：${trail.said.map(row => `「${row.text}」`).join('')}` : '',
    trail.check ? `最后一次项目检查 \`${trail.check.command}\`${trail.check.by === 'plugin' ? '（插件交付时跑的）' : ''}：${trail.check.ok ? '退出码 0' : '退出码非 0'}${trail.check.tail ? `，输出末尾：\n${trail.check.tail}` : ''}` : '',
    !changed ? '' : changed.length ? `开工以来改过的文件：${changed.slice(0, 20).join('、')}${changed.length > 20 ? ` 等 ${changed.length} 个` : ''}` : '开工以来项目文件没有变化',
    saves.length ? `存档：${saves.map(row => `${row.label ?? row.tag}（${row.ref}）`).join('、')}` : '',
  ].filter(Boolean)
  return [`**接手 · ${task.id}** — 从${from ?? '别的会话'}接过来\n${facts.map(line => `事实：${line}`).join('\n')}\n方法：${HANDOFF_LINE}`,
    `dsh-auto-dev handoff ${task.id}`,
    { form: 'handoff', data: { unit: task.id, title: `接手 · ${task.id}`, line: changed?.length ? `改过 ${changed.length} 个文件${trail.check ? `，最后检查${trail.check.ok ? '通过' : '没过'}` : ''}` : `从${from ?? '别的会话'}接过来`, tag: saves.length ? `${saves.length} 个存档` : '已存档', tone: 'neutral' } }]
}
