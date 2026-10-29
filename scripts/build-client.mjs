import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  process.env.ESBUILD_BIN,
  process.env.DSH_SOURCE_ROOT && resolve(process.env.DSH_SOURCE_ROOT, 'node_modules/.bin/esbuild'),
  resolve(root, 'node_modules/.bin/esbuild'),
].filter(Boolean)
const bin = candidates.find(path => path === 'esbuild' || existsSync(path)) ?? 'esbuild'
mkdirSync(resolve(root, 'lib'), { recursive: true })
const result = spawnSync(bin, [
  resolve(root, 'src/client.js'),
  '--bundle', '--format=cjs', '--platform=browser', '--external:react',
  '--banner:js=window.__ModuleLoader__.load({id:"dsh-auto-dev",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  '--footer:js=return module.exports;}});',
  `--outfile=${resolve(root, 'lib/client.js')}`,
], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
