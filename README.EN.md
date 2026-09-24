# dsh-recovery-resume

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
**when DSH restarts, it picks up the task that got cut off and finishes it.**

[中文](README.md) | English

## The problem

You ask the agent to do something, and halfway through DSH restarts (a crash, an upgrade,
or a manual restart). Your session comes back, but the interrupted task **does not continue
on its own** — nothing happens until you send another message.

With this plugin installed, DSH sends that message for you after the restart.

The message is not just "continue". A restart can land in the middle of a download or a
push, so the message asks the agent to **check how far it actually got first**, then carry
on from the right place — without assuming the last step succeeded, or that it failed.

## Install

```sh
dsh plugin --profile web add github:flandre2233/dsh-recovery-resume
```

Then **restart DSH once** so the plugin is loaded.

No dependencies to install, nothing to build.

## When it resumes

Only when **all** of these are true — otherwise it does nothing:

- the last task was cut off (interrupted, errored, or hit the output limit) rather than finishing normally
- you haven't sent a new message or started a new task since
- the interruption happened **within the last 15 minutes**
- the session has been opened again

**It does not resume when retrying can't help** — an invalid API key, no balance left,
or a conversation that has grown past the context limit. Retrying those only costs money.
Which errors count as worth retrying comes from DSH's own official list.

If the session has an **active goal**, the plugin also lets it keep going — the same as
pressing "continue" in the UI. **Goals you paused yourself are never touched.**

## Runaway protection

The thing to avoid is "restart → resume → crash → restart → resume…" burning money forever.
There are three safeguards:

| Safeguard | Rule |
|---|---|
| 1 | at most one resume per session each time DSH starts |
| 2 | after **3 resumes in a row** with no progress, it stops and waits for you (tracked in `$DSH_HOME/recovery-attempts.json`, so restarts don't reset it) |
| 3 | a wait between resumes: **10 minutes** after the first, **20 minutes** after the second |

As soon as a resume actually moves the task forward, these counters reset — the safeguards
only kick in on repeated failure. When a limit is hit, the plugin just logs it.

## Checking it works

Is the plugin loaded?

```sh
dsh --profile web --dump-config | grep -A2 recovery-resume
```

The plugin logs to the terminal running `dsh web`. If you start DSH through a launcher
(such as a desktop app), the log is wherever that launcher saves it — commonly
`~/.dsh/host.log`. That file is created by the launcher, not by DSH, and won't exist if you
run DSH by hand.

```sh
grep dsh-recovery-resume ~/.dsh/host.log   # if your launcher writes one
```

A resume looks like this:

```
dsh-recovery-resume: agent 创建 id=session-… status=idle
dsh-recovery-resume: ★ 发现未处理的中断（reason=interrupted turnSeq=8451 lastTool=bash）
dsh-recovery-resume: 续跑消息已入队 session-…
dsh-recovery-resume: 已重新武装 goal …
```

**Most of the time nothing happens, and that's normal.** The [Chinese README](README.md)
lists the other log lines and what each one means.

## Tests

```sh
npm test    # 85 cases, no dependencies, DSH does not need to be running
```

You can also run a single file, e.g. `node tests/logic.test.mjs` (works on Windows too).

## Limitations

- Only verified on DSH `0.1.6-alpha.1` with macOS 13 (Intel). The plugin relies on DSH
  internals, so **re-run the tests after upgrading DSH**.
- The 15-minute window is fixed and can't be configured yet.
- It doesn't check whether the task was actually finished just before the restart. If it
  was, the agent spends one extra round checking — expected, since the message asks it to.
- Subagent sessions are skipped.

Design notes, DSH source references and real-world test records are in
[docs/notes.md](docs/notes.md) (Chinese).

## License

MIT — see [LICENSE](LICENSE).
