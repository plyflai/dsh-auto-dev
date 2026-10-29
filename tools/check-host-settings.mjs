#!/usr/bin/env node

/**
 * Exercise the real DSH SettingsForms consumer against an AutoDev artifact.
 *
 * This is intentionally a private, listener-free boot. It creates a temporary
 * profile, mounts only ConfigEditor, Settings, and a no-op wrapper around the
 * artifact's exported Config, then calls settings.describe(). A root-only
 * Config.toJSON() check cannot catch a child schema failure; this does.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const valueFor = flag => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const core = resolve(valueFor('--core') ?? '')
const artifact = resolve(valueFor('--artifact') ?? '')
if (!existsSync(join(core, 'packages/boot/app-boot/lib/index.js'))) throw new Error(`invalid --core: ${core}`)
if (!existsSync(join(artifact, 'src/index.js'))) throw new Error(`invalid --artifact: ${artifact}`)

const importCore = relative => import(pathToFileURL(join(core, relative)).href)
const { boot, initProfile, readProfilePatches } = await importCore('packages/boot/app-boot/lib/index.js')
const { default: ConfigEditor } = await importCore('packages/boot/config-editor/lib/index.js')
const { default: Settings } = await importCore('packages/settings/settings/lib/index.js')

const home = await mkdtemp(join(tmpdir(), 'dsh-auto-dev-host-settings-'))
const profileDir = join(home, 'profiles', 'check')
const bundleDir = join(profileDir, 'node_modules', 'check-bundle')
const artifactEntry = join(artifact, 'src/index.js')
const wrapper = join(home, 'auto-dev-schema-wrapper.mjs')
const entryId = 'auto-dev-schema-check'
let ctx
try {
  initProfile(profileDir, ['check-bundle'])
  await mkdir(bundleDir, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"dsh-auto-dev-host-settings-check"}\n')
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'check-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } }
  }))
  await writeFile(wrapper, [
    `export { Config } from ${JSON.stringify(pathToFileURL(artifactEntry).href)}`,
    'export const apply = () => {}',
    'export const name = "dsh-auto-dev-schema-check"',
    '',
  ].join('\n'))
  await writeFile(join(bundleDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: entryId, name: wrapper, config: {} },
  ] }]))
  const profile = {
    name: 'check', startedBundles: ['check-bundle'], dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx = await boot('check', join(profileDir, 'cordis.yml'), readProfilePatches('check', profile), host => {
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady: listener => { listener(); return () => {} } })
    Object.assign(host.loader.builtins, { editor: ConfigEditor, settings: Settings })
  })
  const forms = ctx.settings.describe({ redactSecrets: true })
  const target = forms.find(form => form.ns === entryId)
  if (!target) throw new Error(`settings.describe() did not return ${entryId}`)
  const fields = Object.values(target.schema?.refs ?? {}).filter(ref => ref.meta?.volatile)
  if (fields.length !== 7) throw new Error(`expected 7 AutoDev volatile fields, got ${fields.length}`)
  console.log(JSON.stringify({
    passed: true,
    core,
    artifact,
    entry: entryId,
    formUid: target.schema.uid,
    volatileFields: fields.length,
    fieldNames: Object.keys(target.value ?? {}),
  }, null, 2))
} finally {
  if (ctx) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
