# AGENTS.md

## Project

An OpenCode 2 plugin that replaces the built-in `subagent` tool with two-way subagents: children message and question their parent, the parent steers them, children message each other, and writers can run in git worktrees. Read `docs/ARCHITECTURE.md` before changing the coordinator, the tool split, or worktree handling.

## Commands

- `mise exec --locked -- bun run validate`: typecheck and tests. Run it before every commit.
- `mise exec --locked -- bun run pack:inspect`: check the npm payload after changing `package.json`, `files`, or `skills/`.

## Critical patterns

- Target the OpenCode 2 plugin API only (`{ id, setup }`). Import only types from `@opencode/plugin`; it stays a dev and optional peer dependency.
- Keep `subagent` compatible with OpenCode's built-in tool: same name, the built-in's input fields, result metadata `{ sessionID, status }`, and report metadata `{ source: "subagent", childID, agent, state }`. Other plugins read these.
- Shared state lives in `src/coordinator.ts` on `globalThis` and in plugin storage, because each location runs its own plugin instance. Keep one watcher per child, and save a final status only after the report reaches the parent.
- `ask_parent` must not block a tool call; the child ends its turn and the answer wakes it.
- All model-facing strings live in `src/prompt.ts`, and the delegation playbook lives in `skills/smart-subagents/SKILL.md`. Give each rule one home and keep tool descriptions short, since they are sent on every request.
- Profiles are OpenCode agents. Do not add a plugin-level profile or tier system.
- Test live on an isolated `opencode serve` with its own `XDG_DATA_HOME`, as `docs/DEVELOPMENT.md` describes, never by restarting the user's OpenCode service. Use a cheap model for test sessions.

## Releases

Bump `version` in `package.json` with every functional change; pushing it to `main` publishes through `.github/workflows/publish-npm.yml`. OpenCode does not update an unpinned plugin by itself: after the publish succeeds and npm serves the new tarball, run `opencode plugin update opencode-smart-subagents` from a project directory. The user's OpenCode service loads the new version only after a restart, which needs the user's go-ahead.

## Documentation

- `README.md`: install, tools, options, and limits. Update it when tools, inputs, options, or limits change.
- `docs/ARCHITECTURE.md`: mechanisms and the OpenCode internals to recheck on upgrades.
- `docs/DEVELOPMENT.md`: validation, the live test scenarios, and the upgrade checklist.