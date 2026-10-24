import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { capabilityRules, CHILD_DENIED_TOOLS, childRules, isCapability } from "../src/capability.ts";
import { load, outcome, state, watch, type ChildRecord, type Ctx } from "../src/coordinator.ts";
import plugin, { readSkill } from "../src/index.ts";
import { buildChildPrompt, forkTranscript, latestError, latestReport, parseForkTurns, type ContextMessage } from "../src/messages.ts";
import { parseModelRef, readSettings } from "../src/options.ts";
import { CHILD_SYSTEM_NOTE, CHILD_TOOLS, PARENT_TOOLS } from "../src/prompt.ts";
import { cleanRepoRoot, deleteWorktreeBranch, describeWorktree, inspectWorktree, integrateWorktree, patchWorktree } from "../src/worktree.ts";

// ---------- helpers ----------

const user = (text: string): ContextMessage => ({ type: "user", text });
const assistant = (text: string, completed = true, error?: unknown): ContextMessage =>
  ({ type: "assistant", time: completed ? { completed: 1 } : {}, content: [{ type: "reasoning", text: "private" }, { type: "text", text }], ...(error ? { error } : {}) }) as ContextMessage;

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

function resetState() {
  const shared = state();
  shared.records.clear();
  shared.watching.clear();
  shared.foreground.clear();
  shared.contexts.clear();
  shared.seenEvents.clear();
  shared.loading = undefined;
  shared.delivery = "steer";
}

interface FakeSession {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  messages: ContextMessage[];
  location: string;
}

/** An in-memory stand-in for the parts of the plugin context the plugin uses. */
function fakeContext() {
  const sessions = new Map<string, FakeSession>();
  const storage = new Map<string, unknown>();
  const synthetic: { sessionID: string; text: string; metadata?: Record<string, unknown>; resume?: boolean }[] = [];
  const prompts: { sessionID: string; text: string; delivery?: string }[] = [];
  const waiters = new Map<string, Array<() => void>>();
  const busy = new Set<string>();
  const tools: any[] = [];
  const hooks: Record<string, (event: any) => unknown> = {};
  const skills: any[] = [];
  let created = 0;
  let failSynthetic = false;
  /** What a child does when prompted; defaults to replying with a report. */
  let onPrompt: (session: FakeSession, text: string) => void | Promise<unknown> = (session) => {
    session.messages.push(assistant(`report from ${session.id}`));
    session.outcome = "succeeded";
  };

  const finish = (id: string) => {
    busy.delete(id);
    for (const resolve of waiters.get(id) ?? []) resolve();
    waiters.delete(id);
  };

  const ctx = {
    options: {},
    location: { directory: "/repo" },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...storage.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`no session ${sessionID}`);
        return {
          id: session.id,
          parentID: session.parentID,
          agent: session.agent,
          title: session.title,
          outcome: session.outcome,
          projectID: "project",
          model: { providerID: "p", id: "parent-model" },
          time: { created: 1, updated: 1 },
          location: { directory: session.location },
        };
      },
      context: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID)!.messages,
      create: async (input: { parentID: string; title: string; agent: string }) => {
        const id = `ses_child${++created}`;
        sessions.set(id, { id, parentID: input.parentID, agent: input.agent, title: input.title, messages: [], location: "/repo" });
        return { id };
      },
      prompt: async (input: { sessionID: string; text: string; delivery?: string }) => {
        prompts.push(input);
        const session = sessions.get(input.sessionID)!;
        session.messages.push(user(input.text));
        busy.add(session.id);
        // The run ends only after the child's own work, including any tool calls it makes, has finished.
        setTimeout(async () => {
          await onPrompt(session, input.text);
          if (busy.has(session.id)) finish(session.id);
        }, 5);
        return {};
      },
      wait: ({ sessionID }: { sessionID: string }) =>
        new Promise<void>((resolve) => {
          if (!busy.has(sessionID)) return resolve();
          waiters.set(sessionID, [...(waiters.get(sessionID) ?? []), resolve]);
        }),
      synthetic: async (input: { sessionID: string; text: string; metadata?: Record<string, unknown>; resume?: boolean }) => {
        if (failSynthetic) throw new Error("server shutting down");
        synthetic.push(input);
        return {};
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        if (session) session.outcome = "interrupted";
        finish(sessionID);
        return { interrupted: true };
      },
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      move: async () => undefined,
      remove: async () => undefined,
      hook: async (name: string, callback: (event: any) => unknown) => {
        hooks[name] = callback;
        return { dispose: async () => undefined };
      },
    },
    agent: {
      get: async ({ agentID }: { agentID: string }) =>
        agentID === "build" ? { data: { id: "build", mode: "primary" } } : agentID === "missing" ? Promise.reject(new Error("missing")) : { data: { id: agentID, mode: "subagent" } },
    },
    model: { list: async () => ({ data: [{ providerID: "p", id: "cheap", variants: [{ id: "low" }] }] }) },
    permission: { assert: async () => undefined },
    tool: { transform: async (callback: (editor: any) => void) => callback({ add: (tool: any) => tools.push(tool) }) },
    skill: { transform: async (callback: (editor: any) => void) => callback({ add: (skill: any) => skills.push(skill) }) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    worktree: { create: async () => ({ directory: "/wt" }), remove: async () => undefined },
  };

  return {
    ctx: ctx as unknown as Ctx,
    sessions,
    storage,
    synthetic,
    prompts,
    tools,
    hooks,
    skills,
    busy,
    finish,
    addSession(session: Partial<FakeSession> & { id: string }) {
      sessions.set(session.id, { messages: [], location: "/repo", ...session });
    },
    setOnPrompt(handler: typeof onPrompt) {
      onPrompt = handler;
    },
    setFailSynthetic(value: boolean) {
      failSynthetic = value;
    },
  };
}

const toolContext = (sessionID: string) => ({
  sessionID,
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  signal: new AbortController().signal,
  progress: async () => undefined,
});

async function setupPlugin(fake: ReturnType<typeof fakeContext>, options: Record<string, unknown> = {}) {
  (fake.ctx as unknown as { options: unknown }).options = options;
  const cleanup = await plugin.setup(fake.ctx);
  const tool = (name: string) => fake.tools.find((candidate) => candidate.name === name)!;
  return { cleanup, tool };
}

// ---------- options ----------

test("readSettings uses defaults and reports invalid values", () => {
  const warnings: string[] = [];
  assert.deepEqual(readSettings(undefined, (message) => warnings.push(message)), { resultDelivery: "steer" });
  assert.deepEqual(readSettings({ resultDelivery: "queue" }, (message) => warnings.push(message)), { resultDelivery: "queue" });
  assert.equal(warnings.length, 0);
  const settings = readSettings({ resultDelivery: "later" }, (message) => warnings.push(message));
  assert.deepEqual(settings, { resultDelivery: "steer" });
  assert.equal(warnings.length, 1);
});

test("parseModelRef keeps slashes in the model ID and reads the variant", () => {
  assert.deepEqual(parseModelRef("cliproxy/antigravity/gemini-3.8-flash#low"), { providerID: "cliproxy", id: "antigravity/gemini-3.8-flash", variant: "low" });
  assert.deepEqual(parseModelRef("openai/gpt"), { providerID: "openai", id: "gpt" });
  for (const bad of ["", "noslash", "/model", "provider/", "a/b#c#d"]) assert.equal(parseModelRef(bad), undefined, bad);
});

// ---------- capability ----------

test("capability modes deny only what they remove", () => {
  const actions = (mode: Parameters<typeof capabilityRules>[0]) => capabilityRules(mode).map((rule) => `${rule.action}:${rule.effect}`);
  assert.deepEqual(actions("read-only"), ["edit:deny", "shell:deny"]);
  assert.deepEqual(actions("execute"), ["edit:deny"]);
  assert.deepEqual(actions("read-write"), ["shell:deny"]);
  assert.deepEqual(actions("all"), []);
  assert.deepEqual(actions(undefined), []);
  const childActions = childRules("read-only").map((rule) => `${rule.action}:${rule.effect}`);
  assert.deepEqual(childActions, [...CHILD_DENIED_TOOLS.map((tool) => `${tool}:deny`), "edit:deny", "shell:deny"]);
  assert.equal(childRules(undefined).length, CHILD_DENIED_TOOLS.length);
  assert.equal(isCapability("execute"), true);
  assert.equal(isCapability("everything"), false);
});

// ---------- messages ----------

test("parseForkTurns accepts none, all, and positive counts", () => {
  assert.equal(parseForkTurns(undefined), "none");
  assert.equal(parseForkTurns("none"), "none");
  assert.equal(parseForkTurns("all"), "all");
  assert.equal(parseForkTurns("2"), 2);
  assert.equal(parseForkTurns(3), 3);
  for (const bad of ["0", "-1", "1.5", "some"]) assert.throws(() => parseForkTurns(bad), /fork_turns/);
});

test("forkTranscript copies user and finished assistant text for the requested turns", () => {
  const messages = [user("first"), assistant("one"), { type: "synthetic" } as ContextMessage, user("second"), assistant("two"), user("third"), assistant("unfinished", false)];
  assert.equal(forkTranscript(messages, "none"), undefined);
  const all = forkTranscript(messages, "all")!;
  assert.match(all, /<user>\nfirst\n<\/user>/);
  assert.doesNotMatch(all, /unfinished|private/);
  const recent = forkTranscript(messages, 2)!;
  assert.doesNotMatch(recent, /first/);
  assert.match(recent, /second[\s\S]*two[\s\S]*third/);
});

test("latestReport and latestError read the newest assistant message", () => {
  assert.equal(latestReport([assistant("old"), user("again"), assistant("new"), assistant("streaming", false)]), "new");
  assert.equal(latestReport([user("only")]), undefined);
  assert.equal(latestError([assistant("partial", true, { message: "Step interrupted", type: "aborted" })]), "Step interrupted");
  assert.equal(latestError([assistant("failed", true, { type: "x" }), assistant("ok")]), undefined);
});

test("buildChildPrompt adds the copied conversation only when there is one", () => {
  assert.equal(buildChildPrompt({ prefix: "P", task: "T" }), "P\nT");
  assert.equal(buildChildPrompt({ prefix: "P", task: "T", transcript: "<user>\nhi\n</user>" }), "P\n\n<parent_conversation>\n<user>\nhi\n</user>\n</parent_conversation>\n\nTask:\nT");
});

// ---------- skill ----------

test("readSkill loads the bundled skill without its frontmatter", () => {
  const skill = readSkill("../skills/smart-subagents/SKILL.md");
  assert.equal(skill.id, "smart-subagents");
  assert.match(skill.description ?? "", /^Use only when/);
  assert.match(skill.content, /^# Smart subagents/);
  assert.ok(path.isAbsolute(skill.path));
});

// ---------- coordinator ----------

const record = (id: string, extra: Partial<ChildRecord> = {}): ChildRecord => ({
  id,
  parentID: "ses_parent",
  agent: "general",
  description: "task",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

test("outcome treats an aborted newest message as cancelled even when the session outcome is stale", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_a", outcome: "succeeded", messages: [assistant("half", true, { type: "aborted", message: "Step interrupted" })] });
  assert.equal((await outcome(fake.ctx, record("ses_a"))).state, "cancelled");
  fake.addSession({ id: "ses_b", outcome: "failed", messages: [assistant("", true, { message: "rate limited" })] });
  assert.deepEqual(await outcome(fake.ctx, record("ses_b")), { state: "error", text: "rate limited" });
  fake.addSession({ id: "ses_c", outcome: "succeeded", messages: [assistant("all done")] });
  assert.deepEqual(await outcome(fake.ctx, record("ses_c")), { state: "completed", text: "all done" });
});

test("a watcher delivers the report and saves the status only after delivery", async () => {
  resetState();
  const fake = fakeContext();
  state().contexts.add(fake.ctx);
  fake.addSession({ id: "ses_parent" });
  fake.addSession({ id: "ses_kid", parentID: "ses_parent", outcome: "succeeded", messages: [assistant("result text")] });
  state().records.set("ses_kid", record("ses_kid"));

  fake.setFailSynthetic(true);
  watch(fake.ctx, "ses_kid");
  await until(() => !state().watching.has("ses_kid"), "failed watcher");
  assert.equal(state().records.get("ses_kid")!.status, "running", "a failed send keeps the child running");

  fake.setFailSynthetic(false);
  watch(fake.ctx, "ses_kid");
  await until(() => fake.synthetic.length === 1, "delivery");
  const sent = fake.synthetic[0]!;
  assert.equal(sent.sessionID, "ses_parent");
  assert.deepEqual(sent.metadata, { source: "subagent", childID: "ses_kid", agent: "general", state: "completed" });
  assert.match(sent.text, /<subagent sessionID="ses_kid" state="completed" description="task">\nresult text\n<\/subagent>/);
  await until(() => state().records.get("ses_kid")!.status === "completed", "saved status");
  assert.equal((fake.storage.get("child/ses_kid") as ChildRecord).status, "completed");
});

test("a waiting child reports nothing when its turn ends", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_kid", parentID: "ses_parent", messages: [assistant("asked")] });
  state().records.set("ses_kid", record("ses_kid", { status: "waiting", question: "which?" }));
  watch(fake.ctx, "ses_kid");
  await until(() => !state().watching.has("ses_kid"), "watcher");
  assert.equal(fake.synthetic.length, 0);
});

test("load resumes watching stored children that were running", async () => {
  resetState();
  const fake = fakeContext();
  state().contexts.add(fake.ctx);
  fake.addSession({ id: "ses_parent" });
  fake.addSession({ id: "ses_old", parentID: "ses_parent", outcome: "interrupted", messages: [assistant("partial", true, { type: "aborted", message: "Step interrupted" })] });
  fake.storage.set("child/ses_old", record("ses_old"));
  fake.storage.set("child/ses_done", record("ses_done", { status: "completed" }));
  await load(fake.ctx);
  await until(() => fake.synthetic.length === 1, "recovered delivery");
  assert.equal(fake.synthetic[0]!.metadata?.state, "cancelled");
  assert.equal(state().records.size, 2);
});

// ---------- plugin ----------

test("setup registers the tools and skill, and the context hook splits parent and child tools", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_parent" });
  fake.addSession({ id: "ses_kid", parentID: "ses_parent" });
  const { cleanup } = await setupPlugin(fake);
  assert.deepEqual(fake.tools.map((tool) => tool.name).sort(), [...PARENT_TOOLS, ...CHILD_TOOLS].sort());
  assert.ok(fake.tools.every((tool) => tool.options?.codemode === false));
  assert.deepEqual(fake.skills.map((skill) => skill.id), ["smart-subagents"]);

  const event = (sessionID: string) => ({
    sessionID,
    system: [] as { type: string; text: string }[],
    tools: Object.fromEntries([...PARENT_TOOLS, ...CHILD_TOOLS, "read"].map((name) => [name, { description: "", input: {} }])),
  });
  const parent = event("ses_parent");
  await fake.hooks.context!(parent);
  assert.deepEqual(Object.keys(parent.tools).sort(), [...PARENT_TOOLS, "read"].sort());
  assert.equal(parent.system.length, 0);

  const child = event("ses_kid");
  await fake.hooks.context!(child);
  assert.deepEqual(Object.keys(child.tools), ["read"], "a child the plugin did not start gets neither tool set");
  assert.equal(child.system.length, 0);

  fake.addSession({ id: "ses_tracked", parentID: "ses_parent" });
  state().records.set("ses_tracked", { id: "ses_tracked", parentID: "ses_parent", agent: "general", description: "d", status: "running", createdAt: 1, updatedAt: 1 });
  const tracked = event("ses_tracked");
  await fake.hooks.context!(tracked);
  assert.deepEqual(Object.keys(tracked.tools).sort(), [...CHILD_TOOLS, "read"].sort());
  assert.deepEqual(tracked.system, [{ type: "text", text: CHILD_SYSTEM_NOTE }]);
  if (typeof cleanup === "function") await cleanup();
});

test("a background subagent reports to its parent, and a child cannot start subagents", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_parent" });
  const { tool, cleanup } = await setupPlugin(fake);

  const result = await tool("subagent").execute(
    { agent: "general", description: "look", prompt: "Find it.", background: true, capability: "read-only" },
    toolContext("ses_parent"),
  );
  assert.deepEqual(result.metadata, { sessionID: "ses_child1", status: "running" });
  assert.equal(fake.prompts[0]!.text, "You are a subagent spawned by another session.\nFind it.");
  await until(() => fake.synthetic.length === 1, "report");
  assert.equal(fake.synthetic[0]!.metadata?.childID, "ses_child1");

  await assert.rejects(
    tool("subagent").execute({ agent: "general", description: "nested", prompt: "x" }, toolContext("ses_child1")),
    /cannot start or manage subagents/,
  );
  await assert.rejects(tool("subagent").execute({ agent: "build", description: "x", prompt: "x" }, toolContext("ses_parent")), /cannot run as a subagent/);
  if (typeof cleanup === "function") await cleanup();
});

test("subagent with a running child's sessionID steers it, and the child still sends one report", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_parent" });
  const { tool, cleanup } = await setupPlugin(fake);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.setOnPrompt(async (session, text) => {
    await gate;
    if (!text.startsWith("Also")) {
      session.messages.push(assistant(`report covering ${session.messages.filter((m) => m.type === "user").length} prompts`));
      session.outcome = "succeeded";
    }
  });

  await tool("subagent").execute({ agent: "general", description: "work", prompt: "Start.", background: true }, toolContext("ses_parent"));
  const steered = await tool("subagent").execute({ agent: "general", description: "work", prompt: "Also check docs.", sessionID: "ses_child1" }, toolContext("ses_parent"));
  assert.match(steered.content, /^Steered subagent ses_child1/);
  assert.deepEqual(steered.metadata, { sessionID: "ses_child1", status: "running" });
  assert.equal(fake.prompts.at(-1)!.delivery, "steer");
  await assert.rejects(
    tool("subagent").execute({ agent: "explore", description: "work", prompt: "x", sessionID: "ses_child1" }, toolContext("ses_parent")),
    /Wait for its report before switching/,
  );

  release();
  await until(() => fake.synthetic.length === 1, "report");
  await tick();
  assert.equal(fake.synthetic.length, 1);
  assert.match(fake.synthetic[0]!.text, /report covering 2 prompts/);
  if (typeof cleanup === "function") await cleanup();
});

test("a foreground subagent returns its report, or its question when it asks one", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_parent" });
  const { tool, cleanup } = await setupPlugin(fake);

  const done = await tool("subagent").execute({ agent: "general", description: "quick", prompt: "Answer." }, toolContext("ses_parent"));
  assert.deepEqual(done.metadata, { sessionID: "ses_child1", status: "completed" });
  assert.match(done.content, /report from ses_child1/);

  // The child calls ask_parent during its run, then ends its turn.
  fake.setOnPrompt(async (session) => {
    await tool("ask_parent").execute({ question: "Which name?" }, toolContext(session.id));
    session.messages.push(assistant("asked"));
  });
  const asked = await tool("subagent").execute({ agent: "general", description: "ask", prompt: "Ask first." }, toolContext("ses_parent"));
  assert.deepEqual(asked.metadata, { sessionID: "ses_child2", status: "running" });
  assert.match(asked.content, /Which name\?/);
  assert.equal(fake.synthetic.length, 0, "a foreground question is returned, not sent as a message");

  fake.setOnPrompt((session, text) => {
    session.messages.push(assistant(`named ${text}`));
    session.outcome = "succeeded";
  });
  await tool("subagent_message").execute({ sessionID: "ses_child2", message: "kiwi" }, toolContext("ses_parent"));
  await until(() => fake.synthetic.length === 1, "report after the answer");
  assert.match(fake.synthetic[0]!.text, /named kiwi/);
  if (typeof cleanup === "function") await cleanup();
});

test("subagent_batch starts every child or none", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_parent" });
  const { tool, cleanup } = await setupPlugin(fake);
  const task = (description: string) => ({ agent: "general", description, prompt: "Work." });

  await assert.rejects(tool("subagent_batch").execute({ tasks: [task("a"), { agent: "missing", description: "b", prompt: "x" }] }, toolContext("ses_parent")), /Unknown agent/);
  assert.equal(fake.prompts.length, 0, "a rejected batch starts nothing");

  const result = await tool("subagent_batch").execute({ tasks: [task("a"), task("b")] }, toolContext("ses_parent"));
  assert.equal(result.metadata.sessionIDs.length, 2);
  await until(() => fake.synthetic.length === 2, "both reports");
  if (typeof cleanup === "function") await cleanup();
});

test("peers can list and message each other, and updates do not wake the parent", async () => {
  resetState();
  const fake = fakeContext();
  fake.addSession({ id: "ses_parent" });
  const { tool, cleanup } = await setupPlugin(fake);
  await tool("subagent_batch").execute({ tasks: [{ agent: "general", description: "a", prompt: "A" }, { agent: "general", description: "b", prompt: "B" }] }, toolContext("ses_parent"));
  await until(() => fake.synthetic.length === 2, "first reports");

  const peers = await tool("list_peers").execute({}, toolContext("ses_child1"));
  assert.match(peers.content, /ses_child2 \(general\) completed: b/);
  await tool("message_peer").execute({ sessionID: "ses_child2", message: "banana" }, toolContext("ses_child1"));
  assert.match(fake.prompts.at(-1)!.text, /<peer_message sessionID="ses_child1" description="a">\nbanana\n<\/peer_message>/);
  await until(() => fake.synthetic.length === 3, "report after the peer message");

  await tool("message_parent").execute({ message: "halfway" }, toolContext("ses_child1"));
  const update = fake.synthetic.at(-1)!;
  assert.equal(update.resume, false);
  assert.equal(update.metadata?.source, "subagent-update");

  await assert.rejects(tool("message_parent").execute({ message: "x" }, toolContext("ses_parent")), /Only subagents/);
  await assert.rejects(tool("message_peer").execute({ sessionID: "ses_parent", message: "x" }, toolContext("ses_child1")), /not one of your peers/);
  if (typeof cleanup === "function") await cleanup();
});

// ---------- worktree ----------

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
}

function scratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smart-subagents-test-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  /** A detached worktree, the way OpenCode's git strategy creates one. */
  const addWorktree = (name: string) => {
    const directory = path.join(root, name);
    git(repo, "worktree", "add", "-q", "--detach", directory, "HEAD");
    return directory;
  };
  return { root, repo: fs.realpathSync(repo), addWorktree, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("worktree isolation needs a clean checkout", async () => {
  const scratch = scratchRepo();
  try {
    assert.equal(await cleanRepoRoot(scratch.repo), scratch.repo);
    fs.writeFileSync(path.join(scratch.repo, "new.txt"), "x");
    await assert.rejects(cleanRepoRoot(scratch.repo), /clean checkout/);
  } finally {
    scratch.cleanup();
  }
});

test("a detached worktree gets its own branch, and patch applies uncommitted changes", async () => {
  const scratch = scratchRepo();
  try {
    const info = await describeWorktree(scratch.repo, scratch.addWorktree("wt-patch"), "project");
    assert.equal(info.branch, "opencode-subagent/wt-patch");
    fs.appendFileSync(path.join(info.path, "a.txt"), "two\n");
    fs.writeFileSync(path.join(info.path, "b.txt"), "new\n");
    const inspected = await inspectWorktree(info);
    assert.deepEqual([...inspected.files].sort(), ["a.txt", "b.txt"]);
    assert.equal(inspected.dirty, true);
    const patched = await patchWorktree(info);
    assert.deepEqual([...patched.files].sort(), ["a.txt", "b.txt"]);
    assert.equal(fs.readFileSync(path.join(scratch.repo, "a.txt"), "utf8"), "one\ntwo\n");
    assert.equal(fs.readFileSync(path.join(scratch.repo, "b.txt"), "utf8"), "new\n");
  } finally {
    scratch.cleanup();
  }
});

test("merge and cherry-pick commit the worktree's changes and integrate them", async () => {
  const scratch = scratchRepo();
  try {
    const merged = await describeWorktree(scratch.repo, scratch.addWorktree("wt-merge"), "project");
    fs.appendFileSync(path.join(merged.path, "a.txt"), "merged\n");
    const mergeResult = await integrateWorktree(merged, "merge", "merge test");
    assert.equal(mergeResult.changed, true);
    assert.match(git(scratch.repo, "log", "--oneline", "-1"), /Merge branch 'opencode-subagent\/wt-merge'/);

    const picked = await describeWorktree(scratch.repo, scratch.addWorktree("wt-pick"), "project");
    fs.writeFileSync(path.join(picked.path, "c.txt"), "picked\n");
    const pickResult = await integrateWorktree(picked, "cherry-pick", "pick test");
    assert.equal(pickResult.commits.length, 1);
    assert.equal(fs.readFileSync(path.join(scratch.repo, "c.txt"), "utf8"), "picked\n");
    assert.match(git(scratch.repo, "log", "--format=%s", "-1"), /^Apply subagent changes: pick test$/);

    git(scratch.repo, "worktree", "remove", "--force", picked.path);
    await deleteWorktreeBranch(picked);
    assert.equal(git(scratch.repo, "branch", "--list", picked.branch), "");
    await deleteWorktreeBranch(picked);
  } finally {
    scratch.cleanup();
  }
});

test("a conflicting merge is caught in preflight and leaves the checkout unchanged", async () => {
  const scratch = scratchRepo();
  try {
    const info = await describeWorktree(scratch.repo, scratch.addWorktree("wt-conflict"), "project");
    fs.writeFileSync(path.join(info.path, "a.txt"), "theirs\n");
    fs.writeFileSync(path.join(scratch.repo, "a.txt"), "ours\n");
    git(scratch.repo, "commit", "-qam", "ours");
    const head = git(scratch.repo, "rev-parse", "HEAD");
    await assert.rejects(integrateWorktree(info, "merge", "conflict"), /Preflight found merge conflicts/);
    assert.equal(git(scratch.repo, "rev-parse", "HEAD"), head);
    assert.equal(git(scratch.repo, "status", "--porcelain"), "");
    fs.writeFileSync(path.join(scratch.repo, "dirty.txt"), "x");
    await assert.rejects(integrateWorktree(info, "cherry-pick", "dirty"), /must be clean/);
  } finally {
    scratch.cleanup();
  }
});