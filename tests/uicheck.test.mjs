import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { observedTier, projectTier, touchesScreen, uiMissing, uiNeed } from '../src/uicheck.mjs'

const project = ({ scripts, playwright = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'v3-ui-'))
  if (scripts) writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
  if (playwright) mkdirSync(join(dir, 'test'), { recursive: true }) || writeFileSync(join(dir, 'playwright.config.ts'), 'export default {}')
  return dir
}

test('界面的三档：单元上写了就照她写的，没写就按项目能跑到的那一档', () => {
  const plain = project({ scripts: { test: 'vitest run' } })
  assert.equal(projectTier(plain), 'logic')
  assert.equal(projectTier(project({ scripts: { 'test:ui': 'playwright test' } })), 'browser')
  assert.equal(projectTier(project()), 'static')

  const unit = { id: 'b1', goal: '导出按钮', scope: ['src/components/Export.tsx'] }
  assert.equal(uiNeed(unit, plain).tier, 'logic', '界面单元继承项目能力')
  assert.equal(uiNeed({ ...unit, ui: 'browser' }, plain).tier, 'browser', '单元可以要更高一档')
  assert.equal(uiNeed({ ...unit, ui: false }, plain), undefined, 'ui:false 表示这个单元不需要界面测试')
  assert.equal(uiNeed({ id: 'b2', goal: '调日志', scope: ['src/log.ts'] }, plain), undefined, '不碰界面的单元不欠这一档')
})

test('看出来的是哪一档：浏览器覆盖逻辑、逻辑覆盖类型', () => {
  assert.equal(observedTier([{ command: 'npx tsc --noEmit' }]), 'static')
  assert.equal(observedTier([{ command: 'npm test' }]), 'logic')
  assert.equal(observedTier([{ command: 'npx playwright test --headed' }]), 'browser')
  assert.equal(observedTier([{ command: 'npx tsc --noEmit' }, { command: 'npm test' }]), 'logic', '取最高那档')
  assert.equal(observedTier([{ command: 'ls' }]), undefined, '普通命令不算')
})

test('提交时才算账：跑过就不欠，没跑就点名要哪条命令', () => {
  const ui = project({ scripts: { 'test:ui': 'playwright test' } })
  const unit = { id: 'b1', goal: '按钮', scope: ['src/App.tsx'], ui: 'browser' }
  const gap = uiMissing({ unit, project: ui, rows: [{ command: 'npm test' }] })
  assert.equal(gap.tier, 'browser')
  assert.equal(gap.observed, 'logic')
  assert.match(gap.check.command, /playwright/)
  assert.equal(uiMissing({ unit, project: ui, rows: [{ command: 'npx playwright test' }] }), undefined, '浏览器跑过就清了')
  assert.equal(uiMissing({ unit: { ...unit, ui: 'logic' }, project: ui, rows: [{ command: 'npm test' }] }), undefined, '高档覆盖低档')
})

test('推断出来的档只用来提醒；拦不拦由调用方决定（work_submit 只拦写在单元上的档）', () => {
  const ui = project({ scripts: { test: 'vitest run' } })
  const inferred = { id: 'b9', goal: '页面标题', scope: ['src/pages/Home.tsx'] }
  assert.ok(touchesScreen(inferred), '这确实是个界面单元')
  // 模块本身如实说“欠 logic 这一档”；是有意只为显式声明的档抛错，写在 tools.mjs 的调用条件里，
  // 这样“没跑测试的小改动”不会被一个猜出来的档拦住。
  assert.equal(uiNeed(inferred, ui).tier, 'logic')
  assert.equal(uiMissing({ unit: inferred, project: ui, rows: [] }).tier, 'logic')
})
