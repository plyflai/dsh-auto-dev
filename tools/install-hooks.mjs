/**
 * 把仓库自带的钩子装进 .git/hooks。
 *
 * 钩子本身进仓库（tools/hooks/pre-commit），但 git 不会自动安装它——所以一条
 * 命令装一次，新克隆的机器也知道要做这件事（README「开发检查」里写着）。
 */
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const from = join(root, 'tools/hooks/pre-commit')
const dir = join(root, '.git/hooks')
mkdirSync(dir, { recursive: true })
const to = join(dir, 'pre-commit')
copyFileSync(from, to)
chmodSync(to, 0o755)
console.log(`已安装 ${to}`)
console.log('之后每次提交，只要改了 src/ tests/ tools/，就会先跑 npm run check。')
