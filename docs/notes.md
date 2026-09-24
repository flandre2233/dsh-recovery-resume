# 设计依据与验证记录

这份文件放**「为什么这么写」和「凭什么说它能用」**：源码出处、实测记录、失败过的做法、
风险提示。**给想深挖或 review 的人**；只想用插件的话看 [`../README.md`](../README.md) 就够了。

---

## 1. 为什么需要它：DSH 保证了什么、没保证什么

DSH 自己**不**保证"重启后任务接着做"。它保证的是另外两件事：

| DSH 已经有的 | 说明 |
|---|---|
| **会话恢复** | 客户端把 `{sessionId}` 存进浏览器 localStorage（键 `dsh.sessions.current`），页面重载后重连 —— 所以你重启后**能看到原来的对话** |
| **崩溃修复** | `dsh-session` 的 `interruptedTurnClosers`（由 `dsh-agent-loop` 在加载会话时调用）会给未闭合的回合补上合成事件：`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` + 一条 `turn/end`，reason = `interrupted` |

但它**不会**因为这些去做任何事：新服务进程起来后，那个被打断的回合就静静躺在事件流里，
**直到有人再发一条消息**。于是现象是：窗口回来了、对话在、但 Agent 像下班了一样不动。

---

## 2. 与现成方案 `dsh-client-auto-continue` 的区别

社区里已有 `dsh-client-auto-continue`（作者 HsiangNianian，MIT）。它**功能更全**
（错误分类、退避、循环守卫、通知按钮），本插件是**独立实现**，只解决其中一件事。
两者在**扫描时机**上有关键差异（以下断言的源码出处为 `dsh-client-auto-continue`
**0.11.7** 的 `src/host/engine.ts`，行号可复核）：

| | `dsh-client-auto-continue` 0.11.7 | `dsh-recovery-resume` |
|---|---|---|
| 触发时机 | 服务启动后**立即**扫描（`engine.ts:258` `void this.bootScanLoop()` → `:1006 scanLoop(Infinity, 3000)`） | `agent/created` / `agent/status → idle`，即**会话真正活起来之后** |
| 扫描范围 | `for (const agent of this.ctx.agents.list())`（`engine.ts:1044`）—— **只扫 live agents** | 同上，但因为在会话激活后才触发，候选集**不为空** |
| 扫完之后 | `if (await this.scanInterrupted()) return;`（`engine.ts:1013`）—— **扫一次即退出，不再复查** | 每次 agent 变 idle 都会重新判断 |

**为什么这个差异是决定性的**：服务启动后 3 秒，那个会话通常**还没有变成 live agent**
（没有人打开它 —— 页面还没加载完）。于是候选集为空、扫描"成功"返回、之后再也不会看第二眼。
等页面加载、会话激活时，已经没有任何东西会回头检查了。

> 这不是本机特有的现象，而是上面三条控制流直接推出的结论。本机实测：
> 4 次服务崩溃中断之后，`auto-continue` 每次都只打一行「已启动」，
> 没有任何判定日志、没有任何续跑消息。

**本插件取代了它**（2026-09-19 从 profile 移除）。移除依据就是上面这条实测。

---

## 3. 完整控制流

```
host 崩溃 / 被重启
      │
      ▼
新服务进程启动 → 会话被打开 → agent 创建（status=idle）
      │                       │
      │                       └──► 本插件在这里触发（延迟 3s 让崩溃修复先完成）
      ▼
会话事件流里已有 turn/end reason=interrupted（由 DSH 的崩溃修复写入）
      │
      ▼
判据：尾部最后一条 turn/end 的 reason ∈ {interrupted, error, max-tokens}
      且其后没有 turn/start、没有 source.kind === 'user' 的消息
      且时间足够新（15 分钟内）
      │
      ▼
账本检查：连续未成功续跑 < 3 次？冷却时间过了吗（1 次后 10 分钟，2 次后 20 分钟）？
      │
      ├── 不通过 → 只写日志，停下等人
      ▼
投出续跑消息（agent.followup）→ 记一次账
      │
      ▼
若目标仍是 phase=active 且未用尽轮次 → 重新武装 goal（延后 1.5s，让续跑消息先占住这一轮）
      │
      ▼
Agent 自己核对状态、接着做
```

### 3.1 续跑消息长什么样

**不是**「继续」两个字。重启期间外部世界可能已经变了（下载到一半、`git push` 成功但没落记录、
文件只写了一半），所以消息**要求先核对**：

```xml
<recovery_resume>
这台机器上的 DSH 刚刚重启过（服务进程被换掉了），你上一回合因此被中断。
中断原因：interrupted。
中断前最后一个工具调用是「bash」—— 它可能已经执行成功、执行到一半、或根本没跑起来。

继续之前**必须先核对真实状态**：
1. 先看工作区 / 进程 / 日志，确认中断前那一步到底做成了没有 —— 不要根据对话历史假定它成功，也不要假定它失败。
2. 如果那一步的结果不确定（下载进度、推送是否真的成功、文件写到哪个程度），去查实际证据；必要时用幂等的方式重做。
3. 确认实际状态之后，从正确的位置接着做，不要重复已经完成的动作。

做完要给出可复核的证据（命令输出、文件内容、退出码）。如果无法继续（缺前提、外部不可用），如实说明并停下。
</recovery_resume>
```

`{最后一个工具调用}` 是从事件流里回溯出的最后一条 `tool/call`，用来告诉 Agent
**哪一步的结局没被确认**。

### 3.2 最小上下文（不重述历史）

续跑消息**故意不重述上下文**，只补三样 agent 自己查不到、或不值得再翻一遍的东西：

| 注入内容 | 来源 | 上限 |
|---|---|---|
| 断在第几回合 | 事件流的 `data.turn` | — |
| **结局未确认**的工具调用 | 结构性标记 `data.error.code = TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`（DSH 崩溃修复写入） | 3 个 |
| 中断前最后一条 assistant 文本 | `assistant/message` | 240 字符 |

**为什么这么做**（都是实测/源码依据，不是拍脑袋）：

- 一个挂满工具的会话，第一轮基线约 **41K tokens**。插件注入的这点量相比之下可以忽略；
  真正的浪费是**让 agent 重新翻一遍历史**。
- DSH 的崩溃修复**已经把"结局未知的工具调用"写进了模型可见的历史**（`tool/result`
  带 `error.code = TOOL_OUTCOME_UNKNOWN`；本机实测某会话此类事件结构性出现 27 次）。
  所以那类信息**不必重复注入**，只挑真正需要重述的几样。
- 提取逻辑只认**结构性**标记：那个码在会话里既出现在结构字段里，也出现在正文文本里
  （本机实测 27 : 14）。把正文里的同名字符串当成标记，会提取出假关键点 —— 有单测钉死这一点。

本机用真实会话事件流（7220 条事件）验证过：提取出的关键点约 **313 字符 ≈ 90 tokens**，
是基线上下文的 **0.22%**。上限由 `lib/context.js` 的 `MAX_ASSISTANT_CHARS` /
`MAX_UNCONFIRMED` 控制；提取失败**不影响续跑**（关键点是优化，不是必需品）。

---

## 4. 防失控：为什么必须有三层

没有它会出现**无上限的烧钱循环**：

```
任务被中断 → 重启 → 续跑 → 又中断 → 又重启 → 又续跑 → …（没有东西会叫停）
```

关键是：**进程内计数单独不够用**。服务一重启计数就归零，所以「崩 → 续 → 崩 → 续」
在跨重启的场景里没有东西叫停，每一圈都在烧 token。

| 层 | 限制 | 位置 |
|---|---|---|
| 1 | 同一进程内，同一会话最多续 **1** 次 | `MAX_ATTEMPTS_PER_SESSION` |
| 2 | **跨重启账本**：连续未成功最多 **3** 次 | `lib/ledger.js` → `$DSH_HOME/recovery-attempts.json` |
| 3 | 冷却按 5 分钟 × 2^连续次数 计算，封顶 30 分钟；实际用到的是 **10 分钟**（1 次后）和 **20 分钟**（2 次后），第 3 次后由第 2 层直接停下 | `COOLDOWN_MS` / `effectiveCooldown` |

**退避只惩罚失败**：两个真实缺陷是实测抓出来的，都修了并有单测钉住：

| 缺陷 | 症状 | 修正 |
|---|---|---|
| 退避惩罚了**成功**的续跑 | 续跑成功 → 任务继续 → 又被打断 → 冷却已翻倍到 20 分钟 → **被自己的防失控挡住**（实测日志：「距上次续跑仅 243s，冷却中（本次冷却 1200s，还需 957s）」） | 退避只累计"连续未成功"；`turn/end` 的 seq 比上次记录新 → 判定有进展 → 清零 |
| 旧账本**无声失效** | 缺 `lastTurnSeq` 时进度判据返回 false → 明明有进展仍吃退避 | 没有可比对的 seq 时取对续跑有利的解读（标记 `migrated`），有单测钉住这个反转 |

账本 7 天后自动清理。超限时插件**只写日志、停下等人**，不做任何动作。

### 4.1 关于重新武装 goal

用的是 `ctx.goals.resume(agent, {id, revision})` —— **和界面上那个"继续"按钮同一个 API**。

**只对 `phase === 'active'` 动手。** 这个 API 源码里同时接受 `paused` / `blocked`，
无条件调用会**覆盖你主动暂停的目标**。这是必须守住的红线，有单测钉死。

（goal 的 `activation` 是进程内状态、**故意不进持久化投影** —— 源码注释原话
`initially disarmed`、`activation is deliberately absent`，所以每次服务启动都会被 disarm。）

---

## 5. 日志实现的一个坑

插件用 `console.log` / `console.error` 直写（**不是** `ctx.logger`）。
实测：`ctx.logger.info` 的输出在 DSH 的 host 日志里**一行都找不到**，用它排查会白费一轮。
`console.log` 会进 DSH 进程的 stdout —— **具体落到哪取决于谁起了它**：
手动 `dsh web` 就是终端；fork host 的启动器（如本仓库配套的那个）会把它重定向到
`$DSH_HOME/host.log`。**`host.log` 是启动器造的文件，不是 DSH 自带的**，
所以文档里不能假定它存在。

一次成功的续跑长这样：

```
[dsh-recovery-resume] apply() 被调用 —— 插件已加载
dsh-recovery-resume: agent 创建 id=session-… status=idle
dsh-recovery-resume: session-… 无需续跑（尾部没有未处理的非人为中断）        ← 正常会话
dsh-recovery-resume: ★ session-… 发现未处理的中断（reason=interrupted turnSeq=6805 lastTool=bash）→ 发送续跑消息
dsh-recovery-resume: 续跑消息已入队 session-…（messageId=…）
dsh-recovery-resume: 账本已更新 session-… → 累计续跑 2 次（跨重启上限 3，冷却 300s）
dsh-recovery-resume: ★ 已重新武装 goal goal-…（revision=2）→ 目标可继续推进
```

被限制挡住时（这是**预期的**，不是故障）：

```
dsh-recovery-resume: 跳过 session-…（跨重启已续跑 3 次（上限 3），停下等人确认）
dsh-recovery-resume: 跳过 session-…（距上次续跑仅 42s，冷却中（还需 258s））
dsh-recovery-resume: 不重新武装 goal（phase=complete（只处理 active））
```

### 5.1 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 插件的 stdout 里一行 `dsh-recovery-resume` 都没有 | 插件没被加载：先跑 `dsh --profile web --dump-config \| grep -A2 recovery-resume`；确认装完**重启过** DSH |
| `读不到 … 的事件流（既没有 snapshotEvents() 也没有 events）` | DSH 版本的会话 API 变了。当前写法：优先 `session.snapshotEvents()`，回退属性 `session.events` |
| `Cannot find package '@deepseek-ai/dsh-llm'` | **初版的问题，现已不存在** —— 插件改为零 host 依赖（见 README「安装」）。还见到说明装的是旧版本 |
| 插件把整棵树搞崩、DSH 起不来 | 从 `$DSH_HOME/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉本插件，再 `dsh plugin --profile web install` |

---

## 6. 真实验证记录（2026-09-23）

单测之外，三条判据分支都在**真实环境**里跑过一遍。做法是临时把
`api.deepseek.com` 解析到 `127.0.0.1`（黑洞）来制造真实的模型调用失败，
再重启 DSH 观察插件行为。

| 分支 | 做法 | 观测到的证据（插件 stdout / 会话事件流原文） |
|---|---|---|
| **临时性失败 → 续跑** | 黑洞造成 `code=TRANSPORT` 失败 | `★ 发现未处理的中断（reason=error turnSeq=…）→ 发送续跑消息`；事件流出现 `user/message source=dsh-recovery-resume` |
| **永久性失败 → 跳过** | 临时写入无效 API key 造成 `code=AUTH status=401` | `跳过 …（上次失败是永久性的，重试无益：HTTP 401（认证/权限） code=AUTH）`，且**没有**续跑消息 |
| **DSH 重启截断 → 续跑 + 重新武装 goal** | `cycle` 重启 | 续跑消息 + `goal/change op=resume`，随后 goal 驱动器自己开了下一轮 |

完整链条（**全程没有任何 `source=user` 消息**，即无人参与）：

```
turn/end  reason=error  code=TRANSPORT      ← 真实失败
user/message  source=dsh-recovery-resume    ← 插件续跑（error 分支）
goal/change  op=resume                      ← 重新武装 goal
turn/end  reason=interrupted                ← 服务重启截断
user/message  source=dsh-recovery-resume    ← 插件续跑（interrupted 分支）
user/message  source=goal  round=1          ← goal 驱动器自己开轮
```

> ⚠️ 这些测试需要临时改 `/etc/hosts`，是**有风险的操作**。本仓库不提供自动化脚本 ——
> 第一次尝试时因为用 `shutil.copy2`（没带 `sudo`）去还原而失败，**把机器断网了 13 分钟**。
> 如果将来要复现：① 改动前先用 `sudo -n` 在**目标文件真实路径**上演练"写回"；
> ② 准备好干净备份与一条人工恢复命令；③ 注意"常驻自愈守护"与"保住故障窗口"是互斥的。

### 6.1 0.1.3 的端到端复验（2026-09-25）

0.1.3 在独立环境里重新跑了一遍主流程（识别中断 → 续跑 → agent 继续工作 → 账本落盘 → 进程内去重），
全部通过，记录见 [e2e-0.1.3-macos.md](e2e-0.1.3-macos.md)。

0.1.3 唯一的行为改动是「重新武装 goal 失败后的重试」。goal 的正常重新武装已在上面 0.1.2 的记录里实测过；
重试这一小段需要"授权失败的同一瞬间目标恰好被暂停"，真实环境难以稳定触发，由 `tests/index.test.mjs` 覆盖。

---

## 7. 实现细节：为什么不用 `createUserMessage`

**初版** `import { createUserMessage } from '@deepseek-ai/dsh-llm'`。问题（实测）：
那个包只在 DSH 安装目录里，插件目录里的软链指向**绝对路径**、又被 `.gitignore` 挡住 ——
**别人 clone 下来装必然 `MODULE_NOT_FOUND`，整棵插件树会崩**。
（对照：同机已装的另外 5 个 out-of-tree 插件一个都不 import host 包。）

现在内联在 `lib/message.js`，4 个字段（`id`/`role`/`content`/`source`）。安全性依据：

1. **host 不校验消息**：`dsh-agent-loop` 的 `followup(input)` = `send(input, "next-turn", true)`
   → `inbox.splice(...)` 入队，**没有任何运行时断言**。
2. **字段要求只有 4 个**：`UserMessage` 是结构化类型（`Message` + `role: 'user'`），
   没有私有类、没有 `instanceof`、没有 symbol 字段。
3. **`id` 必须唯一且非空**：`dsh-agent-loop` 维护一个 `Set`，重复 id 会抛
   `message "…" is already pending`；`undefined` 则多条消息共享同一个 key
   → **续跑消息被静默丢掉**。这是"续跑不生效"最隐蔽的失效方式，所以每条都生成 `randomUUID()`。
4. **`createUserMessage` 本体只是** `createMessage({ ...input, role: 'user' })`，
   而 `createMessage` 只多做两件事：加 `brandString(randomUUID())`（**仅编译期品牌，
   运行时返回原字符串**）与 `deepFreeze`。**冻结不是语义要求** —— host 自己的投影代码
   用 `structuredClone` 处理输入，不要求预先冻结。
5. **`source` 是纯数据**：host 只用它做 `source.kind === 'plugin' && source.plugin === SOURCE`
   这类判断，不调用其上的方法。
6. **`content` 必须是块数组**：官方类型是 `ContentBlock[]`，本插件的 `renderResumePrompt()`
   返回的正是 `[{ type: 'text', text: … }]`。

顺带修掉一处**自造字段**：`source` 里曾多传 `turnSeq`，而它在 dsh-llm 的类型定义里
**零命中**（官方只有 `{ kind: 'plugin', plugin: string } & ContextFormed`）。

**防回归**：`tests/message.test.mjs` 在**清空 `NODE_PATH` 的子进程**里导入模块，
并扫描整个 `lib/` 不许出现 `@deepseek-ai/` 的 import。

### 7.1 一条给其他插件作者的记录：peer 范围匹配不到预发布版本

awesome-dsh-plugin 的贡献指南建议给官方 `@deepseek-ai/*` 包声明"带显式预发布分支"的
peer 范围，例如 `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`。
**实测这个范围匹配不到任何当前版本**：node-semver 7.8.5 下它对 `0.1.6-alpha.1`
与 `0.1.7-alpha.2` 都返回 `false`。

原因：semver 的预发布规则**逐元组**生效 —— 只有范围内某个比较符的
`major.minor.patch` 与目标版本完全一致、且自身带预发布标签时，该预发布版本才被放行。
上面示例的比较符落在 `0.1.0` 元组，而实际版本是 `0.1.6-*`，于是被静默排除。
能匹配的写法都必须钉死在具体元组上（`>=0.1.6-alpha.1 <0.2.0-0`），
**没有一个范围能表达"覆盖整条 0.1.x 预发布线"**。

（本插件没有 peer 依赖，所以这条记录不影响它。）

---

## 8. 已知限制（完整版）

- **只在 DSH `0.1.6-alpha.1` + macOS 13（Intel）上实测过**。会话事件与 agent 生命周期
  属于 DSH 内部 API，**cross-version 兼容性没有保证**；升级 DSH 后请重新跑一遍测试。
- **"新鲜度"窗口固定 15 分钟**（`FRESH_MS`）。超过就不翻旧账 —— 一个几小时前的中断
  未必还该自动接着做。目前不可配置。
- **不判断"任务是否其实已经完成"**：判据只看 `turn/end` 的 reason 与之后有无新回合/用户消息。
  如果任务在被中断前已经做完了，续跑会多问一轮（消息里要求先核对状态，属于预期行为，
  但仍会消耗一轮）。DSH 的 goal 机制有 `complete` 动作可以表达"做完了"，本插件不代它判断。
- **错误码表是抄 DSH 官方那份**（`@deepseek-ai/dsh-llm/retry-policy` 的
  `DEFAULT_RETRYABLE_CODES`）。DSH 升级后如果这张表变了，本插件需要跟着更新 ——
  它的"可重试"判断直接依赖这份名单。
- **真实测试覆盖到的是"模型调用失败"这一类**（TRANSPORT / AUTH）。工具执行失败、
  上下文超限等其他失败形态没有单独造过真实场景，只走了单测。
- **子代理会话不处理**（`session.header.origin === 'subagent'` 直接跳过，与上游一致）。
- 多标签页/多窗口同时打开同一会话时，靠**host 侧单实例**与账本去重；本插件本身没有锁。
