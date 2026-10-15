# Development

The toolchain is pinned in `mise.toml`, and Bun manages dependencies through `bun.lock`. OpenCode loads the TypeScript sources directly, so there is no build step.

## Commands

- `mise install --locked`: install the pinned Bun and Node.
- `mise exec --locked -- bun install`: install locked dependencies.
- `mise exec --locked -- bun run validate`: typecheck.
- `mise exec --locked -- bun run pack:inspect`: list what the npm package would contain.

## Run a local checkout

Add the checkout's absolute path to `plugins` in the OpenCode configuration. OpenCode loads a local plugin directory from `index.ts` at its root, which re-exports `src/index.ts`; published installs use the `exports` entry in `package.json` instead.

## Test against a live OpenCode

Test on a separate server so the live service and its sessions are untouched. It reads the normal configuration, including the plugin entry, but keeps its own sessions and plugin storage:

```bash
mkdir -p /tmp/smart-subagents-test/data /tmp/smart-subagents-test/state
XDG_DATA_HOME=/tmp/smart-subagents-test/data XDG_STATE_HOME=/tmp/smart-subagents-test/state \
  opencode serve --hostname 127.0.0.1 --port 4199
```

The server prints its password on start; the API uses HTTP basic auth with the user `opencode`. Create sessions with `POST /api/session` (`location`, `model`, `agent`), prompt them with `POST /api/session/<id>/prompt`, list children with `GET /api/session?parentID=<id>`, and read transcripts with `GET /api/session/<id>/message?order=asc`. Use a cheap model for the parent; `general` children inherit it.

Use a scratch git repository with one commit as the session location, and run these scenarios:

1. A background child: its report arrives in the parent as a `subagent` synthetic message and starts a parent turn.
2. A background child that calls `ask_parent`: the question arrives, no report is sent when the child pauses, and the report arrives after `subagent_message` answers it.
3. A foreground child with `capability: "read-only"` lists its tools (only the four child tools, no edit tools) and cannot edit; a foreground child that asks a question returns the question as the tool result.
4. `subagent_batch` with three children, where one messages another with `message_peer`, sends `message_parent`, and a third is stopped with `subagent_stop`: the peer message wakes its target, the update arrives, and the stopped child reports `cancelled`.
5. `fork_turns: "all"` after the parent was told a fact: the child repeats it.
6. `isolation: "worktree"`: the child's `pwd` is the worktree; `subagent_apply` with `inspect`, `merge`, and `discard` reports the change, merges it into the scratch repository, and removes the worktree and its branch.
7. A prompt sent straight to a child session: its report still reaches the parent.
8. Restart the test server while a background child runs `sleep 60`: after the restart, touch the location (`GET /api/plugin?location[directory]=<repo>`), and the parent's inbox has a `cancelled` report.

Remove the test worktrees and stop the test server afterwards.

## Upgrading OpenCode

1. Raise `@opencode/plugin` in `devDependencies` and the `peerDependencies` floor, then run `bun install`.
2. Check the internals listed in [ARCHITECTURE.md](ARCHITECTURE.md#opencode-internals-this-depends-on).
3. Run `validate` and the live test above.