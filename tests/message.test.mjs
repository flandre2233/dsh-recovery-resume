/**
 * 消息构造器单测：buildUserMessage
 *
 * 零依赖，脱离 DSH 直接跑：
 *   node tests/message.test.mjs
 *
 * 为什么这个文件必须存在 —— 它钉的是**移植性修复之后不能退化的四件事**：
 *
 *   ① **不许再引入 host 包 import**。0.1.0 之前这里 import
 *      `@deepseek-ai/dsh-llm` 的 `createUserMessage`，而那个包只在 DSH 安装目录里、
 *      插件目录里的软链又指向绝对路径 → 别人 clone 下来装会 `MODULE_NOT_FOUND`
 *      直接崩。本文件用「子进程真的去加载一遍模块」来钉住这件事，而不是读源码猜。
 *   ② **`id` 每次都要唯一且非空**。`dsh-agent-loop` 维护一个 `Set`，重复 id 会抛
 *      `message "…" is already pending`，而 undefined 会让多条消息共享同一个 key
 *      → 续跑消息被静默丢掉。这是"续跑不生效"最隐蔽的失败方式。
 *   ③ **字段形状必须等于官方 `UserMessage`**：恰好 4 个字段、无多余字段
 *      （曾经多传过自造的 `turnSeq`，而它在 dsh-llm 类型定义里零命中）。
 *   ④ **`content` 必须是块数组**，不是字符串 —— 官方类型是 `ContentBlock[]`。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { buildUserMessage } from '../lib/message.js'
import { renderResumePrompt } from '../lib/logic.js'

let pass = 0
let fail = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    pass += 1
  } catch (error) {
    console.log(`  ❌ ${name}\n     ${error && error.message ? error.message : error}`)
    fail += 1
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = { kind: 'dsh-recovery-resume', plugin: 'dsh-recovery-resume' }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── ① 形状：恰好等于官方 UserMessage 的四个字段 ─────────────────────────────
test('字段恰好是 id/role/content/source，无多余字段', () => {
  const m = buildUserMessage({ content: [{ type: 'text', text: 'hi' }], source: SOURCE })
  assert.deepEqual(Object.keys(m).sort(), ['content', 'id', 'role', 'source'])
})

test('role 固定是 user（构造器不接受覆盖）', () => {
  const m = buildUserMessage({ content: [], source: SOURCE, role: 'assistant' })
  assert.equal(m.role, 'user')
})

test('source 原样带过去（host 靠 kind+plugin 认领消息）', () => {
  const m = buildUserMessage({ content: [], source: SOURCE })
  assert.equal(m.source.kind, 'dsh-recovery-resume')
  assert.equal(m.source.plugin, 'dsh-recovery-resume')
})

// ── ② id：唯一 + 非空 + UUID 形状 ────────────────────────────────────────────
test('id 是 UUID 形状（randomUUID 的产物）', () => {
  const m = buildUserMessage({ content: [], source: SOURCE })
  assert.match(m.id, UUID_V4)
})

test('连续两次调用 id 不同（host 用 Set 去重，撞了会抛错）', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i += 1) ids.add(buildUserMessage({ content: [], source: SOURCE }).id)
  assert.equal(ids.size, 200, '200 次调用必须得到 200 个不同 id')
})

test('id 不含 undefined/null 字面量（真 id 忘了传时最容易长成这样）', () => {
  const m = buildUserMessage({ content: [], source: SOURCE })
  assert.ok(!String(m.id).includes('undefined'))
  assert.ok(!String(m.id).includes('null'))
  assert.ok(m.id.length > 0)
})

// ── ③ content：必须是块数组，且与 renderResumePrompt 的输出对得上 ────────────
test('content 传块数组时原样保留', () => {
  const blocks = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]
  const m = buildUserMessage({ content: blocks, source: SOURCE })
  assert.equal(m.content, blocks)
})

test('renderResumePrompt 的输出就是 ContentBlock[]（不是字符串）', () => {
  const blocks = renderResumePrompt({ reason: 'interrupted', turnSeq: 42, lastTool: 'bash' })
  assert.ok(Array.isArray(blocks), '必须是数组，字符串会让模型收不到正文')
  assert.ok(blocks.length >= 1)
  for (const block of blocks) assert.equal(typeof block.type, 'string')
})

test('端到端：真实续跑文案装进消息后形状仍合法', () => {
  const m = buildUserMessage({
    content: renderResumePrompt({ reason: 'interrupted', turnSeq: 7, lastTool: 'bash' }),
    source: SOURCE,
  })
  assert.equal(m.role, 'user')
  assert.ok(m.content.every((b) => typeof b.type === 'string'))
  const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.ok(text.length > 0, '正文不能是空的')
  // 文案的核心要求：必须先核对真实状态，不许假定外部操作成功或失败
  assert.match(text, /核对|确认|实际状态/)
})

// ── ④ 移植性：模块加载不许依赖任何 host 包 ─────────────────────────────────────
test('在干净环境下导入 lib/message.js 不需要任何 @deepseek-ai 包', () => {
  // 用子进程 + 空白解析路径跑，证明"零 host 依赖"是真的靠模块系统做到的，
  // 而不是靠本机恰好存在的 node_modules 软链。
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'message.js')).href)});
    const msg = m.buildUserMessage({ content: [], source: { kind: 'p', plugin: 'p' } });
    if (!msg.id || msg.role !== 'user') process.exit(3);
    process.stdout.write('ok');
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    // NODE_PATH 清空：不借助任何外部解析路径
    env: { ...process.env, NODE_PATH: '' },
  })
  assert.equal(out.trim(), 'ok')
})

test('lib/index.js 里不存在对 host 包的 import（防回归）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  const hostImports = imports.filter((s) => s.startsWith('@deepseek-ai/'))
  assert.deepEqual(hostImports, [], `入口不许 import host 包，发现：${hostImports.join(', ')}`)
})

test('整个 lib/ 目录都不 import host 包（防回归）', () => {
  const files = ['index.js', 'logic.js', 'ledger.js', 'context.js', 'failure.js', 'message.js']
  const offenders = []
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'lib', f), 'utf8')
    // 只看真正的 import 语句行，避免把注释里提到的包名算进来
    for (const line of src.split(/\r?\n/)) {
      if (!/^\s*import\b/.test(line)) continue
      if (/from\s+'@deepseek-ai\//.test(line)) offenders.push(`${f}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `发现 host 包 import：\n${offenders.join('\n')}`)
})

test('package.json 不再声明 peerDependencies（没有需要声明的包了）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.peerDependencies, undefined)
})

console.log(`\n  message: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
