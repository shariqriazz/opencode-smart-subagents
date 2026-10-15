import type { Plugin } from "@opencode/plugin";
import { latestError, latestReport, type ContextMessage } from "./messages.ts";
import type { Delivery } from "./options.ts";
import { NO_TEXT, resultMessage, type ResultState } from "./prompt.ts";
import type { WorktreeInfo } from "./worktree.ts";

export type Ctx = Plugin.Context;
export type ChildStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface ChildRecord {
  id: string;
  parentID: string;
  agent: string;
  description: string;
  status: ChildStatus;
  /** The question a waiting child asked its parent. */
  question?: string;
  worktree?: WorktreeInfo;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_PREFIX = "child/";
const WATCH_RETRIES = 3;
const WATCH_RETRY_DELAY_MS = 1_000;

interface State {
  records: Map<string, ChildRecord>;
  loading?: Promise<void>;
  /** Children whose current run has a completion watcher. */
  watching: Set<string>;
  /** Children a foreground `subagent` call is waiting on; that call reports their result itself. */
  foreground: Set<string>;
  /** Live plugin instances, one per location, used when a watcher's own instance has gone away. */
  contexts: Set<Ctx>;
  delivery: Delivery;
  /** Event IDs already handled, so each instance's event stream doesn't repeat work. */
  seenEvents: Set<string>;
}

/**
 * OpenCode runs one plugin instance per location and unloads idle ones, but every instance shares the server process,
 * its event bus, and this plugin's storage. The state lives on `globalThis` so instances agree on which child has a
 * watcher, and in storage so a restart can pick up children that never reported back.
 */
const KEY = Symbol.for("opencode-smart-subagents/state/v1");
const globalState = globalThis as typeof globalThis & { [KEY]?: State };

export function state(): State {
  globalState[KEY] ??= {
    records: new Map(),
    watching: new Set(),
    foreground: new Set(),
    contexts: new Set(),
    delivery: "steer",
    seenEvents: new Set(),
  };
  return globalState[KEY]!;
}

const warn = (message: string) => console.warn(`[opencode-smart-subagents] ${message}`);

export async function save(ctx: Ctx, record: ChildRecord) {
  record.updatedAt = Date.now();
  state().records.set(record.id, record);
  await ctx.storage.set(`${STORAGE_PREFIX}${record.id}`, JSON.parse(JSON.stringify(record)));
}

/** Loads stored children once per process and resumes watching the ones that were still running. */
export function load(ctx: Ctx): Promise<void> {
  const shared = state();
  shared.loading ??= (async () => {
    let after: string | undefined;
    do {
      const page = await ctx.storage.scan({ prefix: STORAGE_PREFIX, ...(after ? { after } : {}), limit: 500 });
      for (const entry of page.entries) {
        const record = entry.value as unknown as ChildRecord;
        if (record && typeof record.id === "string" && !shared.records.has(record.id)) shared.records.set(record.id, record);
      }
      after = page.next;
    } while (after);
    for (const record of shared.records.values()) if (record.status === "running") watch(ctx, record.id);
  })().catch((error) => {
    shared.loading = undefined;
    warn(`could not load stored subagents: ${String(error)}`);
  });
  return shared.loading;
}

export const children = (parentID: string) => [...state().records.values()].filter((record) => record.parentID === parentID);
export const runningCount = (parentID: string) => children(parentID).filter((record) => record.status === "running").length;

function liveContext(preferred: Ctx): Ctx | undefined {
  const contexts = state().contexts;
  if (contexts.has(preferred)) return preferred;
  return contexts.values().next().value;
}

/** The final report and outcome of a child's last run, read once it is idle. */
export async function outcome(ctx: Ctx, record: ChildRecord): Promise<{ state: ResultState; text: string }> {
  const [info, messages] = await Promise.all([
    ctx.session.get({ sessionID: record.id }),
    ctx.session.context({ sessionID: record.id }) as Promise<ContextMessage[]>,
  ]);
  const report = latestReport(messages);
  // The newest assistant message describes the run that just ended; the session outcome can still describe an
  // earlier run while a shutdown interrupts this one.
  const error = latestError(messages);
  const interrupted = info.outcome === "interrupted" || (error !== undefined && /\baborted\b|interrupted/i.test(error));
  if (interrupted) return { state: "cancelled", text: report ? `Subagent cancelled. Its last report:\n\n${report}` : "Subagent cancelled" };
  if (error !== undefined || info.outcome === "failed") return { state: "error", text: error ?? report ?? "Subagent failed" };
  return { state: "completed", text: report ?? NO_TEXT };
}

const statusOf = (result: ResultState): ChildStatus => (result === "completed" ? "completed" : result === "error" ? "failed" : "cancelled");

/** Records the result of a child's last run and returns it. */
export async function settle(ctx: Ctx, record: ChildRecord) {
  const result = await outcome(ctx, record);
  record.status = statusOf(result.state);
  await save(ctx, record);
  return result;
}

/** Sends the report to the parent, then records it. A failed send leaves the child running, so a restart retries it. */
async function deliver(ctx: Ctx, record: ChildRecord) {
  const result = await outcome(ctx, record);
  await ctx.session.synthetic({
    sessionID: record.parentID,
    description: record.description,
    text: resultMessage(record, result.state, result.text),
    metadata: { source: "subagent", childID: record.id, agent: record.agent, state: result.state },
    delivery: state().delivery,
  });
  record.status = statusOf(result.state);
  await save(ctx, record);
}

/**
 * Waits for a background child to go idle, then delivers its report to the parent. One watcher per child: OpenCode's
 * wait follows runs that start while it waits, such as a steer. A child waiting on its question reports nothing,
 * because the question already reached the parent.
 */
export function watch(ctx: Ctx, id: string) {
  const shared = state();
  if (shared.watching.has(id) || shared.foreground.has(id)) return;
  shared.watching.add(id);
  void (async () => {
    let current: Ctx | undefined = ctx;
    for (let attempt = 0; ; attempt++) {
      try {
        await current!.session.wait({ sessionID: id });
        break;
      } catch (error) {
        current = liveContext(ctx);
        if (!current || attempt + 1 >= WATCH_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, WATCH_RETRY_DELAY_MS));
      }
    }
    shared.watching.delete(id);
    const record = shared.records.get(id);
    if (!record || record.status !== "running" || shared.foreground.has(id)) return;
    await deliver(liveContext(current!) ?? current!, record);
  })().catch((error) => {
    shared.watching.delete(id);
    warn(`could not report subagent ${id}: ${String(error)}`);
  });
}

/**
 * A run of a known child that the plugin did not start, such as the user typing into the child's session, gets a
 * watcher too, so its report still reaches the parent.
 */
export function handleEvent(ctx: Ctx, event: { id?: string; type: string; data?: unknown }) {
  if (event.type !== "session.execution.started") return;
  const shared = state();
  if (event.id) {
    if (shared.seenEvents.has(event.id)) return;
    shared.seenEvents.add(event.id);
    if (shared.seenEvents.size > 1_000) shared.seenEvents.delete(shared.seenEvents.values().next().value!);
  }
  const id = (event.data as { sessionID?: unknown } | undefined)?.sessionID;
  if (typeof id !== "string") return;
  const record = shared.records.get(id);
  if (!record || shared.watching.has(id) || shared.foreground.has(id)) return;
  if (record.status !== "running" || record.question) {
    record.status = "running";
    record.question = undefined;
    void save(ctx, record).catch((error) => warn(`could not save subagent ${id}: ${String(error)}`));
  }
  watch(ctx, id);
}