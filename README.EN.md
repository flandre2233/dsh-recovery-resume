# dsh-recovery-resume

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that
resumes a turn interrupted by a host restart — and makes the agent **verify real-world
state first** instead of blindly sending "continue".

[中文](README.md) | English

## Why

DSH restores your session after a restart, and its crash repair writes a
`turn/end reason=interrupted` for the cut-off turn. But nothing acts on that: the turn
just sits there until you send another message. This plugin does that part.

The continuation message is not the word "continue". A restart can happen mid-download or
mid-push, so the message tells the agent to check what actually happened, redo
idempotently when unsure, and never assume a side effect succeeded or failed.

## Install

```sh
dsh plugin --profile web add github:flandre2233/dsh-recovery-resume
```

Then restart DSH (host-side plugins are not hot-reloaded).

No external dependencies: no `@deepseek-ai/*` imports, no `node_modules`, nothing to build.

## When it fires

Only when all of these hold, otherwise it does nothing:

- the last `turn/end` in the session log has reason `interrupted`, `error`, or `max-tokens`
- nothing follows it — no new turn, no message from you
- the interruption is at most 15 minutes old
- the session actually becomes live (`agent/created` or `agent/status → idle`)

Permanent failures (`AUTH`, quota exhausted, context overflow) are skipped — retrying them
would only burn tokens. The code list comes from DSH's own `DEFAULT_RETRYABLE_CODES`.

It also re-arms an `active` goal (the same API as the "continue" button in the UI) so goal
rounds keep advancing. `paused` and `blocked` goals are left alone.

## Runaway protection

Three layers, because in-process counters reset on every restart:

| Layer | Limit |
|---|---|
| 1 | one resume per session per process |
| 2 | three consecutive unsuccessful resumes, tracked across restarts in `$DSH_HOME/recovery-attempts.json` |
| 3 | at least 5 minutes between resumes |

Backoff only counts *failures*: if the turn sequence advanced since the last attempt, the
counter resets. Over the limit, it logs and stops.

## Checking it works

```sh
dsh --profile web --dump-config | grep -A2 recovery-resume   # loaded?
```

For what it decided, look where your DSH process writes stdout: the plugin logs with
`console.log`, so the lines appear in the terminal running `dsh web`, or in whatever your
launcher redirects that stream to (an app bundle that forks the host typically appends it to
`~/.dsh/host.log` — that file is the launcher's, not DSH's, and will not exist if you start
DSH by hand). Grep for `dsh-recovery-resume`:

```sh
grep dsh-recovery-resume ~/.dsh/host.log   # if your launcher writes one
```

A trigger looks like this:

```
dsh-recovery-resume: agent 创建 id=session-… status=idle
dsh-recovery-resume: ★ 发现未处理的中断（reason=interrupted turnSeq=8451 lastTool=bash）
dsh-recovery-resume: 续跑消息已入队 session-…
dsh-recovery-resume: 已重新武装 goal …
```

Silence is normal when there is nothing to resume. The README.zh.md has the full list of
log lines and what each one means.

## Tests

```sh
bash tests/run.sh    # 82 cases, zero dependencies, DSH does not need to be running
```

## Limitations

- Tested only against DSH `0.1.6-alpha.1` on macOS 13 (Intel). Session events and the agent
  lifecycle are internal APIs — re-run the tests after upgrading DSH.
- The 15-minute freshness window is fixed, not configurable.
- Does not decide whether the task was actually finished before the interruption. If it was,
  you get one extra round (the message asks the agent to check first).
- Subagent sessions are skipped.

Design notes, source references, and the real-environment verification records are in
[docs/notes.md](docs/notes.md) (Chinese).

## License

MIT — see [LICENSE](LICENSE).
