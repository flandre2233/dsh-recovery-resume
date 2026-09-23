# dsh-recovery-resume

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件：
重启后被中断的回合自动接起来继续做 —— 而且要求 Agent **先核对真实状态**，不是简单发一句「继续」。

中文 | [English](README.EN.md)

## 为什么需要它

重启后 DSH 会恢复你的会话，崩溃修复也会给被截断的回合补上 `turn/end reason=interrupted`。
但**没有任何东西会因此行动**：那个回合就静静躺在事件流里，直到你再发一条消息。本插件补的就是这一环。

续跑消息不是「继续」两个字。重启可能发生在一半的下载或推送中间，所以消息要求 Agent
先查实际发生了什么、不确定就用幂等的方式重做，**不许假定成功，也不许假定失败**。

## 安装

```sh
dsh plugin --profile web add github:flandre2233/dsh-recovery-resume
```

装完**重启 DSH**（host 侧插件不会热加载）。

零外部依赖：不 import `@deepseek-ai/*`、不需要 `node_modules`、没有构建步骤。

## 什么时候会触发

下面几条**同时**成立才续跑，否则不动：

- 会话日志里最后一条 `turn/end` 的 reason 是 `interrupted` / `error` / `max-tokens`
- 它之后没有新回合、也没有你发的消息
- 中断在 **15 分钟**以内
- 会话真的活了（`agent/created` 或 `agent/status → idle`）

**永久性失败不续跑**（`AUTH`、配额耗尽、上下文超限）—— 重试只会烧 token。
判断用的是 DSH 官方错误码表 `DEFAULT_RETRYABLE_CODES`。

它还会重新武装 `active` 状态的 goal（就是界面上「继续」按钮用的同一个 API），
让目标自己继续推进；**`paused` / `blocked` 的目标绝不动**。

## 防失控（三层）

进程内计数在每次重启时归零，所以必须有三层：

| 层 | 限制 |
|---|---|
| 1 | 同一进程内，同一会话最多续 1 次 |
| 2 | **跨重启**连续未成功最多 3 次（`$DSH_HOME/recovery-attempts.json`） |
| 3 | 两次续跑至少间隔 5 分钟 |

退避**只累计失败**：如果回合序号比上次记录前进了，计数清零。
超限时只写日志、停下等人。

## 怎么确认它在工作

```sh
dsh --profile web --dump-config | grep -A2 recovery-resume   # 插件加载了吗
```

要看它的判断，得找你的 DSH 进程把 stdout 写到哪：插件用 `console.log`，
所以这些行会出现在跑 `dsh web` 的那个终端里，或者出现在你的启动器把它重定向到的地方
（fork host 的 app 包通常追加到 `~/.dsh/host.log` —— **那是启动器造的文件，不是 DSH 的**；
手动起 DSH 就不会有它）。按名字过滤：

```sh
grep dsh-recovery-resume ~/.dsh/host.log   # 如果你的启动器会写这个文件
```

触发时长这样：

```
dsh-recovery-resume: agent 创建 id=session-… status=idle
dsh-recovery-resume: ★ 发现未处理的中断（reason=interrupted turnSeq=8451 lastTool=bash）
dsh-recovery-resume: 续跑消息已入队 session-…
dsh-recovery-resume: 已重新武装 goal …
```

**什么都没发生**是正常的。下面这些说法也都是正常的，不是故障：

| 日志 | 含义 |
|---|---|
| `无需续跑（尾部没有未处理的中断）` | 上次正常结束，或你已经处理过了 |
| `跳过 …（上次失败是永久性的…）` | 认证/配额/上下文超限 → 重试无益，正确行为 |
| `跳过 …（本次进程已续跑 1 次）` | 第一层限制生效 |
| `冷却中（还需 N 秒）` | 第三层限制生效 |
| 一行都没有 | 插件没被加载 —— 先跑上面的 `--dump-config` |

## 测试

```sh
bash tests/run.sh    # 82 个用例，零依赖，不需要 DSH 在运行
```

## 已知限制

- 只在 DSH `0.1.6-alpha.1` + macOS 13（Intel）上实测过。会话事件与 agent 生命周期是 DSH
  内部 API，**升级 DSH 后请重跑测试**。
- 15 分钟的新鲜度窗口是固定的，不可配置。
- **不判断"任务是否其实已经做完了"**：如果是，会多问一轮（消息里要求先核对状态，属预期行为）。
- 子代理会话不处理。

设计依据、源码出处、真实验证记录在 [docs/notes.md](docs/notes.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
