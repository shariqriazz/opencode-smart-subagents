---
name: smart-subagents
description: Use only when the user explicitly asks OpenCode to use subagents, delegate work, run agents in parallel, or names this skill. Do not use merely because a task is large, complex, multi-domain, or could run in parallel.
---

# Smart subagents

Each subagent is an OpenCode child session with its own context window. It cannot start subagents of its own, and the user can open it like any other session.

## Activation boundary

Delegate only when the user explicitly asks for it. Task size or convenience is not authorization. If the user asks only to set up or explain delegation, do not start productive work beyond that request.

## Choose the operation

- `subagent` starts one child. Foreground, the default, waits and returns the child's report; use it for a short task whose answer you need before going on. `background: true` returns at once; use it for work that can run while you do something else.
- `subagent_batch` starts several independent background children. Either all of them start or none do.
- `subagent_message` steers a running child, answers a child's question, or gives an idle child its next task. Use it instead of starting a duplicate.
- To continue a finished child in the foreground, or with a different agent or model, call `subagent` with its `sessionID`. The child keeps its full session history.
- `subagent_status` lists your children, their status, and pending questions, and shows the latest output of children you name. It never waits.
- `subagent_stop` stops exact running children and keeps their sessions.

## Wait by notification

A background child's report arrives as a message. While you are working, it lands at your next step; when you are idle, it starts your next turn.

After dispatching background work:

1. Continue only work that is independently useful to the requested result.
2. If none remains, end the turn. A short progress note is enough when the user needs one.
3. Do not call `subagent_status` in the same turn just because a child started. Ending the turn is the waiting mechanism.
4. When a report arrives, treat it as that child's result and continue the original task: reconcile it, launch any queued follow-up work, and otherwise keep waiting for the remaining reports. Do not wait for the user or call a status tool to fetch the same result.
5. When some children have reported and others are still running, never end a turn with an empty message; to the user that looks like a freeze. Write one short line, such as `3 of 5 workers done; waiting on the rest`, and end the turn.

Check progress only when the user asks, a child has run far longer than its task should take, an interruption left its state unclear, or the answer changes an immediate coordination decision. After a check, act on it or end the turn. Never poll on a schedule, and never use a loop, timer, `sleep`, or background shell to schedule a later check.

## Write complete assignments

Without `fork_turns`, the child sees only its prompt. State:

- the objective and the report or artifact you expect;
- relevant paths, sources, and current facts;
- allowed scope and what it must not touch;
- whether it may edit files or run commands;
- the validation and evidence required before it reports done.

Leave `fork_turns` unset for implementation, testing, and documentation work. Use a number of recent user turns only when that history materially matters, and `all` only when the full conversation is necessary. A fork copies user messages and finished assistant text, never tool calls or reasoning.

## Agents, access, and isolation

Pick an agent from the list on the `subagent` tool. Each OpenCode agent brings its own model, permissions, and description, and agents the user defines in configuration appear there too.

Give each child the narrowest access that can finish the work. `capability` narrows the agent's permissions for one child:

- `read-only`: no edits and no shell. The child can still read, glob, and grep, so it can find files.
- `execute`: shell but no edits. Use it for audits and checks, and tell the child to run only non-mutating commands.
- `read-write`: edits but no shell.
- `all`, or no capability: the agent's own permissions.

Capability limits the built-in edit and shell tools. Tools from MCP servers and other plugins keep the agent's permissions.

Leave `model` unset so the child uses its agent's model, or yours when the agent has none. Never move children to a more expensive model or variant unless the user asked; a batch of ten children multiplies that cost by ten.

Leave `isolation` unset for read-only work and for writers with clearly separate files. When two or more children will write concurrently in a repository that compiles or typechecks, give each writer `isolation: "worktree"`, because half-finished edits in one checkout break each other's builds. OpenCode creates the worktree where its worktree settings say. Isolation needs a clean source checkout, so commit or stash first or run the writers one after another. Isolation does not authorize publishing.

## Coordinate and integrate

Parallelize independent reads freely, and concurrent writes only across clearly separate files. You stay responsible for resolving contradictions and validating the combined result.

Children can send you updates (`<subagent_update>`), ask questions (`<subagent_question>`), and message their peers. A child that asked a question has stopped and reports nothing until you answer. Answer with `subagent_message`; when the answer needs the user's authority, ask the user instead of inventing one.

Inspect a finished worktree child with `subagent_apply` and `action: "inspect"` before integrating it. Prefer `patch` when the source checkout has unrelated changes. Use `cherry-pick` or `merge` only on a clean checkout; both are tried in a temporary worktree first. Use `discard` only when losing that worktree is intended.

## Completion gate

A child's report is evidence to review, not proof. Before answering the user:

1. Read the complete report.
2. Inspect the changed files or live state.
3. Check the work against the original request and boundaries.
4. Run proportionate validation when integration could cause regressions.
5. Report verified results separately from claims you could not confirm.