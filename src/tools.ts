import { CAPABILITIES, childRules, isCapability, type Capability } from "./capability.ts";
import { children, load, save, settle, state, watch, type ChildRecord, type Ctx } from "./coordinator.ts";
import { buildChildPrompt, forkTranscript, latestReport, parseForkTurns, type ContextMessage } from "./messages.ts";
import { parseModelRef, type ModelRef } from "./options.ts";
import * as text from "./prompt.ts";
import { cleanRepoRoot, deleteWorktreeBranch, describeWorktree, inspectWorktree, integrateWorktree, patchWorktree, WORKTREE_ACTIONS, type WorktreeAction } from "./worktree.ts";

type ToolEditor = Parameters<Parameters<Ctx["tool"]["transform"]>[0]>[0];
type ToolInfo = Parameters<ToolEditor["add"]>[0];
type ToolContext = Parameters<ToolInfo["execute"]>[1];
type SessionInfo = Awaited<ReturnType<Ctx["session"]["get"]>>;

const str = (description: string) => ({ type: "string", description }) as const;
const ISOLATIONS = ["none", "worktree"] as const;

const spawnFields = {
  agent: str(text.PARAM.agent),
  description: str(text.PARAM.description),
  prompt: str(text.PARAM.prompt),
  model: str(text.PARAM.model),
  fork_turns: str(text.PARAM.forkTurns),
  isolation: { type: "string", enum: ISOLATIONS, description: text.PARAM.isolation },
  capability: { type: "string", enum: CAPABILITIES, description: text.PARAM.capability },
} as const;

interface SpawnSpec {
  agent: string;
  description: string;
  prompt: string;
  model?: string;
  fork_turns?: string;
  isolation?: (typeof ISOLATIONS)[number];
  capability?: Capability;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function readSpec(value: unknown): SpawnSpec {
  if (!isRecord(value)) throw new Error("Each subagent needs agent, description, and prompt.");
  const agent = optionalString(value.agent);
  const description = optionalString(value.description);
  const prompt = typeof value.prompt === "string" ? value.prompt : undefined;
  if (!agent || !description || !prompt?.trim()) throw new Error("Each subagent needs agent, description, and prompt.");
  const isolation = optionalString(value.isolation);
  if (isolation && isolation !== "none" && isolation !== "worktree") throw new Error('isolation must be "none" or "worktree".');
  const capability = optionalString(value.capability);
  if (capability && !isCapability(capability)) throw new Error(`capability must be one of ${CAPABILITIES.join(", ")}.`);
  return {
    agent,
    description,
    prompt,
    model: optionalString(value.model),
    fork_turns: optionalString(value.fork_turns),
    isolation: isolation as SpawnSpec["isolation"],
    capability: capability as Capability | undefined,
  };
}

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "subagent";

/** Plugin tools registered for one location, sharing the process-wide coordinator. */
export function createTools(ctx: Ctx) {
  const sessionCache = new Map<string, Promise<SessionInfo>>();
  const getSession = (sessionID: string) => {
    let cached = sessionCache.get(sessionID);
    if (!cached) {
      cached = ctx.session.get({ sessionID });
      cached.catch(() => sessionCache.delete(sessionID));
      sessionCache.set(sessionID, cached);
    }
    return cached;
  };

  /** True when the session is a child, which may not start or manage subagents. */
  const isChild = async (sessionID: string) => state().records.has(sessionID) || !!(await getSession(sessionID)).parentID;

  async function requireParent(sessionID: string) {
    await load(ctx);
    const session = await ctx.session.get({ sessionID });
    if (session.parentID) throw new Error("Subagents cannot start or manage subagents. Ask your parent with ask_parent instead.");
    return session;
  }

  /** A child of `parentID`. Children started before the plugin loaded are adopted on first use. */
  async function ownChild(id: string, parentID: string): Promise<ChildRecord> {
    const known = state().records.get(id);
    if (known) {
      if (known.parentID !== parentID) throw new Error(`Session ${id} is not one of your subagents.`);
      return known;
    }
    const session = await ctx.session.get({ sessionID: id }).catch(() => undefined);
    if (!session || session.parentID !== parentID) throw new Error(`Session ${id} is not one of your subagents.`);
    const record: ChildRecord = {
      id,
      parentID,
      agent: session.agent ?? "subagent",
      description: session.title ?? id,
      status: "completed",
      createdAt: session.time.created,
      updatedAt: Date.now(),
    };
    await save(ctx, record);
    return record;
  }

  async function resolveModel(input: string): Promise<ModelRef> {
    const ref = parseModelRef(input);
    if (!ref) throw new Error(`Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`);
    const models = (await ctx.model.list()).data;
    const model = models.find((item) => item.providerID === ref.providerID && item.id === ref.id);
    if (!model) throw new Error(`Model "${ref.providerID}/${ref.id}" is not available.`);
    if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant)) {
      const available = model.variants.map((variant) => variant.id).join(", ");
      throw new Error(`Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}".${available ? ` Available: ${available}.` : " Omit the variant."}`);
    }
    return ref;
  }

  async function resolveAgent(id: string) {
    const agent = (await ctx.agent.get({ agentID: id }).catch(() => undefined))?.data;
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    if (agent.mode === "primary") throw new Error(`Agent ${id} cannot run as a subagent.`);
    return agent;
  }

  async function assertAllowed(context: ToolContext, agentID: string) {
    await ctx.permission.assert({
      action: "subagent",
      resources: [agentID],
      save: [agentID],
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    });
  }

  interface Prepared {
    spec: SpawnSpec;
    agent: Awaited<ReturnType<typeof resolveAgent>>;
    model?: ModelRef;
    turns: ReturnType<typeof parseForkTurns>;
  }

  async function prepare(context: ToolContext, spec: SpawnSpec): Promise<Prepared> {
    const agent = await resolveAgent(spec.agent);
    await assertAllowed(context, agent.id);
    return { spec, agent, model: spec.model ? await resolveModel(spec.model) : undefined, turns: parseForkTurns(spec.fork_turns) };
  }

  /** Creates the child session and records it; the caller sends the first prompt. */
  async function create(parent: SessionInfo, prepared: Prepared) {
    const { spec, agent } = prepared;
    let worktree: ChildRecord["worktree"];
    if (spec.isolation === "worktree") {
      const repoRoot = await cleanRepoRoot(parent.location.directory);
      const created = await ctx.worktree.create({ projectID: parent.projectID, name: `subagent-${slug(spec.description)}-${Date.now().toString(36)}` });
      worktree = await describeWorktree(repoRoot, created.directory, parent.projectID);
    }
    const transcript =
      prepared.turns === "none" ? undefined : forkTranscript((await ctx.session.context({ sessionID: parent.id })) as ContextMessage[], prepared.turns);
    const model = prepared.model ?? agent.model ?? parent.model;
    // Explicit permissions replace the ones a child would inherit from its parent session, so carry those over first.
    const child = await ctx.session.create({
      parentID: parent.id,
      title: spec.description,
      agent: agent.id,
      ...(model ? { model } : {}),
      permissions: [...(parent.permissions ?? []), ...childRules(spec.capability)],
    });
    // OpenCode creates a child in its parent's location. The move goes through the child's inbox, so wait for it to
    // apply and confirm it before the first prompt; otherwise the first run would still work in the parent's checkout.
    if (worktree) {
      await ctx.session.move({ sessionID: child.id, directory: worktree.path, delivery: "steer" });
      await ctx.session.wait({ sessionID: child.id });
      const moved = await ctx.session.get({ sessionID: child.id });
      if (moved.location.directory !== worktree.path) {
        await ctx.session.remove({ sessionID: child.id }).catch(() => undefined);
        await ctx.worktree.remove({ projectID: worktree.projectID, directory: worktree.path, force: true }).catch(() => undefined);
        throw new Error(`Could not move the subagent into its worktree ${worktree.path}; it is still in ${moved.location.directory}.`);
      }
    }
    const record: ChildRecord = {
      id: child.id,
      parentID: parent.id,
      agent: agent.id,
      description: spec.description,
      status: "running",
      ...(worktree ? { worktree } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await save(ctx, record);
    const prompt = buildChildPrompt({ prefix: text.CHILD_PROMPT_PREFIX, task: spec.prompt, transcript });
    return { record, prompt, model };
  }

  /** Waits for a foreground child, stopping it if the parent's call is cancelled. */
  async function waitForeground(record: ChildRecord, signal: AbortSignal) {
    const shared = state();
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          void ctx.session.interrupt({ sessionID: record.id }).catch(() => undefined);
          reject(new Error(`Subagent cancelled (sessionID: ${record.id})`));
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        ctx.session.wait({ sessionID: record.id }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    } finally {
      shared.foreground.delete(record.id);
    }
    const current = shared.records.get(record.id) ?? record;
    if (current.status === "waiting" && current.question) {
      // The child paused on a question, so it becomes a background child: its next report arrives as a message.
      return { content: text.foregroundQuestion(record.id, current.question), metadata: { sessionID: record.id, status: "running" } };
    }
    const result = await settle(ctx, current);
    if (result.state === "error") throw new Error(`Subagent failed (sessionID: ${record.id}): ${result.text}`);
    if (result.state === "cancelled") throw new Error(`Subagent cancelled (sessionID: ${record.id})`);
    return {
      content: `<subagent sessionID="${record.id}" state="completed">\n${result.text}\n</subagent>`,
      metadata: { sessionID: record.id, status: "completed" },
    };
  }

  /** Sends a prompt to a child and either waits for it or starts its completion watcher. */
  async function run(record: ChildRecord, prompt: string, background: boolean, signal: AbortSignal) {
    const shared = state();
    if (!background) shared.foreground.add(record.id);
    try {
      await ctx.session.prompt({ sessionID: record.id, text: prompt });
    } catch (error) {
      shared.foreground.delete(record.id);
      record.status = "failed";
      await save(ctx, record);
      throw new Error(`Failed to prompt subagent ${record.id}: ${String(error)}`);
    }
    if (background) {
      watch(ctx, record.id);
      return { content: text.backgroundStarted(record.id, record.agent, record.worktree?.path), metadata: { sessionID: record.id, status: "running" } };
    }
    return waitForeground(record, signal);
  }

  const subagent: ToolInfo = {
    name: "subagent",
    description: text.SUBAGENT_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: {
        ...spawnFields,
        sessionID: str(text.PARAM.sessionID),
        background: { type: "boolean", description: text.PARAM.background },
      },
      required: ["agent", "description", "prompt"],
    },
    async execute(input, context) {
      const parent = await requireParent(context.sessionID);
      const spec = readSpec(input);
      const background = (input as { background?: unknown }).background === true;
      const continueID = optionalString((input as { sessionID?: unknown }).sessionID);
      await context.progress({ status: "running" });

      if (continueID) {
        const record = await ownChild(continueID, parent.id);
        if (record.status === "running") throw new Error(`Subagent ${record.id} is still running. Steer it with subagent_message.`);
        const agent = await resolveAgent(spec.agent);
        await assertAllowed(context, agent.id);
        const model = spec.model ? await resolveModel(spec.model) : agent.id !== record.agent ? agent.model : undefined;
        if (agent.id !== record.agent) await ctx.session.switchAgent({ sessionID: record.id, agent: agent.id });
        if (model) await ctx.session.switchModel({ sessionID: record.id, model });
        record.agent = agent.id;
        record.status = "running";
        record.question = undefined;
        await save(ctx, record);
        await context.progress({ sessionID: record.id, status: "running" });
        return run(record, spec.prompt, background, context.signal);
      }

      const prepared = await prepare(context, spec);
      const { record, prompt } = await create(parent, prepared);
      await context.progress({ sessionID: record.id, status: "running" });
      return run(record, prompt, background, context.signal);
    },
  };

  const batch: ToolInfo = {
    name: "subagent_batch",
    description: text.BATCH_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          description: text.PARAM.tasks,
          items: { type: "object", properties: spawnFields, required: ["agent", "description", "prompt"] },
        },
      },
      required: ["tasks"],
    },
    async execute(input, context) {
      const parent = await requireParent(context.sessionID);
      const tasks = (input as { tasks?: unknown }).tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must list at least one subagent.");
      const specs = tasks.map(readSpec);
      const prepared: Prepared[] = [];
      for (const spec of specs) prepared.push(await prepare(context, spec));

      const started: ChildRecord[] = [];
      try {
        for (const item of prepared) {
          const { record, prompt } = await create(parent, item);
          started.push(record);
          await ctx.session.prompt({ sessionID: record.id, text: prompt });
          watch(ctx, record.id);
        }
      } catch (error) {
        for (const record of started) {
          await ctx.session.interrupt({ sessionID: record.id }).catch(() => undefined);
          record.status = "cancelled";
          await save(ctx, record).catch(() => undefined);
        }
        throw new Error(`No subagents were left running: starting ${prepared[started.length]?.spec.description ?? "one"} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const lines = started.map((record) => `- ${record.id} (${record.agent}${record.worktree ? `, worktree ${record.worktree.path}` : ""}): ${record.description}`);
      return {
        content: [`Started ${started.length} subagents in the background:`, ...lines, "Each report will arrive as a message. Continue independent work or end your turn; don't poll for them."].join("\n"),
        metadata: { sessionIDs: started.map((record) => record.id), status: "running" },
      };
    },
  };

  const message: ToolInfo = {
    name: "subagent_message",
    description: text.MESSAGE_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: { sessionID: str(text.PARAM.messageTarget), message: str(text.PARAM.message) },
      required: ["sessionID", "message"],
    },
    async execute(input, context) {
      const parent = await requireParent(context.sessionID);
      const { sessionID, message: body } = input as { sessionID?: unknown; message?: unknown };
      if (typeof sessionID !== "string" || typeof body !== "string" || !body.trim()) throw new Error("sessionID and message are required.");
      const record = await ownChild(sessionID, parent.id);
      const answered = record.status === "waiting";
      const wasRunning = record.status === "running";
      record.status = "running";
      record.question = undefined;
      await save(ctx, record);
      await ctx.session.prompt({ sessionID: record.id, text: body, delivery: "steer" });
      watch(ctx, record.id);
      const verb = answered ? "Answered" : wasRunning ? "Steered" : "Continued";
      return {
        content: `${verb} subagent ${record.id}. Its report will arrive as a message.`,
        metadata: { sessionID: record.id, status: "running" },
      };
    },
  };

  const status: ToolInfo = {
    name: "subagent_status",
    description: text.STATUS_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: { sessionIDs: { type: "array", items: { type: "string" }, description: text.PARAM.statusIDs } },
    },
    async execute(input, context) {
      const parent = await requireParent(context.sessionID);
      const ids = (input as { sessionIDs?: unknown }).sessionIDs;
      const named = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      for (const id of named) await ownChild(id, parent.id);
      const list = children(parent.id).sort((a, b) => a.createdAt - b.createdAt);
      if (list.length === 0) return { content: "You have no subagents." };
      const now = Date.now();
      const lines: string[] = [];
      for (const record of list) {
        const minutes = Math.max(0, Math.round((now - record.createdAt) / 60_000));
        lines.push(`- ${record.id} (${record.agent}) ${record.status}, started ${minutes}m ago: ${record.description}${record.worktree ? ` [worktree ${record.worktree.path}]` : ""}`);
        if (record.question) lines.push(`  Question: ${record.question}`);
        if (named.includes(record.id)) {
          const messages = (await ctx.session.context({ sessionID: record.id })) as ContextMessage[];
          const latest = latestReport(messages);
          lines.push(latest ? `  Latest output:\n${latest.slice(-4_000).replace(/^/gm, "    ")}` : "  No output yet.");
        }
      }
      return { content: lines.join("\n") };
    },
  };

  const stop: ToolInfo = {
    name: "subagent_stop",
    description: text.STOP_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: { sessionIDs: { type: "array", items: { type: "string" }, minItems: 1, description: text.PARAM.stopIDs } },
      required: ["sessionIDs"],
    },
    async execute(input, context) {
      const parent = await requireParent(context.sessionID);
      const ids = (input as { sessionIDs?: unknown }).sessionIDs;
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("sessionIDs must list at least one subagent.");
      const lines: string[] = [];
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const record = await ownChild(id, parent.id);
        if (record.status !== "running" && record.status !== "waiting") {
          lines.push(`${id}: not running (${record.status}).`);
          continue;
        }
        await ctx.session.interrupt({ sessionID: id });
        if (record.status === "waiting") {
          record.status = "cancelled";
          record.question = undefined;
          await save(ctx, record);
        }
        lines.push(`${id}: stopped.`);
      }
      return { content: lines.join("\n") };
    },
  };

  const apply: ToolInfo = {
    name: "subagent_apply",
    description: text.APPLY_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: {
        sessionID: str(text.PARAM.applyTarget),
        action: { type: "string", enum: WORKTREE_ACTIONS, description: text.PARAM.applyAction },
      },
      required: ["sessionID"],
    },
    async execute(input, context) {
      const parent = await requireParent(context.sessionID);
      const { sessionID, action: rawAction } = input as { sessionID?: unknown; action?: unknown };
      if (typeof sessionID !== "string") throw new Error("sessionID is required.");
      const action = (rawAction ?? "patch") as WorktreeAction;
      if (!WORKTREE_ACTIONS.includes(action)) throw new Error(`action must be one of ${WORKTREE_ACTIONS.join(", ")}.`);
      const record = await ownChild(sessionID, parent.id);
      const worktree = record.worktree;
      if (!worktree) throw new Error(`Subagent ${sessionID} has no isolated worktree.`);
      if (record.status === "running" && action !== "inspect") throw new Error(`Subagent ${sessionID} is still running; wait for its report or stop it before ${action}.`);

      if (action === "inspect") {
        const result = await inspectWorktree(worktree);
        const files = result.files.length ? `\n${result.files.join("\n")}` : "";
        return {
          content: `${sessionID}: ${result.files.length} changed file(s), ${result.commits.length} commit(s), uncommitted changes: ${result.dirty ? "yes" : "no"}. Worktree ${worktree.path}, branch ${worktree.branch}.${files}`,
          metadata: { sessionID, action, ...result },
        };
      }
      if (action === "discard") {
        await ctx.permission.assert({
          action: "edit",
          resources: [worktree.path],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        });
        await ctx.worktree.remove({ projectID: worktree.projectID, directory: worktree.path, force: true });
        await deleteWorktreeBranch(worktree);
        record.worktree = undefined;
        await save(ctx, record);
        return { content: `Discarded the worktree ${worktree.path} and branch ${worktree.branch} of ${sessionID}.`, metadata: { sessionID, action } };
      }
      const result = action === "patch" ? await patchWorktree(worktree) : await integrateWorktree(worktree, action, record.description);
      return {
        content: result.changed
          ? `${action} applied ${result.files.length} file(s) from ${sessionID} to ${worktree.repoRoot}:\n${result.files.join("\n")}`
          : `${sessionID} has no changes to ${action}.`,
        metadata: { sessionID, action, ...result },
      };
    },
  };

  async function requireChild(sessionID: string) {
    await load(ctx);
    const record = state().records.get(sessionID);
    if (!record) throw new Error("Only subagents can use this tool.");
    return record;
  }

  const messageParent: ToolInfo = {
    name: "message_parent",
    description: text.MESSAGE_PARENT_DESCRIPTION,
    options: { codemode: false },
    input: { type: "object", properties: { message: str(text.PARAM.update) }, required: ["message"] },
    async execute(input, context) {
      const record = await requireChild(context.sessionID);
      const body = (input as { message?: unknown }).message;
      if (typeof body !== "string" || !body.trim()) throw new Error("message is required.");
      await ctx.session.synthetic({
        sessionID: record.parentID,
        description: record.description,
        text: text.updateMessage(record, body.trim()),
        metadata: { source: "subagent-update", childID: record.id },
        delivery: "steer",
        resume: false,
      });
      return { content: "Sent to your parent. Keep working." };
    },
  };

  const askParent: ToolInfo = {
    name: "ask_parent",
    description: text.ASK_PARENT_DESCRIPTION,
    options: { codemode: false },
    input: { type: "object", properties: { question: str(text.PARAM.question) }, required: ["question"] },
    async execute(input, context) {
      const record = await requireChild(context.sessionID);
      const question = (input as { question?: unknown }).question;
      if (typeof question !== "string" || !question.trim()) throw new Error("question is required.");
      record.status = "waiting";
      record.question = question.trim();
      await save(ctx, record);
      // A foreground parent is blocked in its subagent call, which returns the question once this turn ends.
      if (!state().foreground.has(record.id)) {
        await ctx.session.synthetic({
          sessionID: record.parentID,
          description: record.description,
          text: text.questionMessage(record, record.question),
          metadata: { source: "subagent-question", childID: record.id },
          delivery: "steer",
        });
      }
      return { content: "Your parent has the question. End your turn now; the answer will arrive as your next message." };
    },
  };

  const listPeers: ToolInfo = {
    name: "list_peers",
    description: text.LIST_PEERS_DESCRIPTION,
    options: { codemode: false },
    input: { type: "object", properties: {} },
    async execute(_input, context) {
      const record = await requireChild(context.sessionID);
      const peers = children(record.parentID).filter((peer) => peer.id !== record.id);
      if (peers.length === 0) return { content: "You have no peers." };
      return { content: peers.map((peer) => `- ${peer.id} (${peer.agent}) ${peer.status}: ${peer.description}`).join("\n") };
    },
  };

  const messagePeer: ToolInfo = {
    name: "message_peer",
    description: text.MESSAGE_PEER_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: { sessionID: str(text.PARAM.peer), message: str(text.PARAM.peerMessage) },
      required: ["sessionID", "message"],
    },
    async execute(input, context) {
      const record = await requireChild(context.sessionID);
      const { sessionID, message: body } = input as { sessionID?: unknown; message?: unknown };
      if (typeof sessionID !== "string" || typeof body !== "string" || !body.trim()) throw new Error("sessionID and message are required.");
      const peer = state().records.get(sessionID);
      if (!peer || peer.parentID !== record.parentID || peer.id === record.id) throw new Error(`Session ${sessionID} is not one of your peers.`);
      if (peer.status !== "running") {
        peer.status = "running";
        peer.question = undefined;
        await save(ctx, peer);
      }
      await ctx.session.prompt({ sessionID: peer.id, text: text.peerMessage(record, body.trim()), delivery: "steer" });
      watch(ctx, peer.id);
      return { content: `Sent to ${peer.id}.` };
    },
  };

  return {
    tools: [subagent, batch, message, status, stop, apply, messageParent, askParent, listPeers, messagePeer],
    isChild,
  };
}