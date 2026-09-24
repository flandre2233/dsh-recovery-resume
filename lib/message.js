/**
 * 构造一条 user 消息，交给 `agent.followup()`。
 *
 * 为什么自己写，而不用 DSH 的 `createUserMessage`：那个函数在 DSH 自己的包里，
 * 插件被别人 clone 下来安装时找不到这个包，会直接报 MODULE_NOT_FOUND。
 * 社区插件的通行做法也是不依赖宿主包。
 *
 * 自己写是安全的：DSH 收消息时不做运行时校验，只要四个字段——
 *   - `id`：必须唯一且非空（DSH 用它去重，重复会报错），所以每次生成新 UUID
 *   - `role`：固定 'user'
 *   - `content`：内容块数组，例如 [{ type: 'text', text: '…' }]，不能是字符串
 *   - `source`：来源标记，纯数据
 * 官方版本另外会把对象冻结，但没有任何代码依赖这一点，这里就不做了。
 * 详细核对过程见 docs/notes.md 第 7 节。
 */

import { randomUUID } from 'node:crypto'

/**
 * 构造一条带唯一 id 的 user 消息。
 *
 * @param {{ content: unknown, source: { kind: string, plugin: string } }} input
 *   消息内容与来源标记。来源用插件自己的名字，这样能分清哪条是插件发的、
 *   哪条是用户本人发的（判断"有没有人处理过"时只认用户本人的消息）。
 * @returns {{ id: string, role: 'user', content: unknown, source: object }}
 *   可直接交给 `agent.followup()` 的消息对象。
 */
export function buildUserMessage(input) {
  return {
    id: randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source,
  }
}
