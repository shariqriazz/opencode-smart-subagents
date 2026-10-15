/** The stored-message fields the plugin reads from `session.context`. */
export type ContextMessage =
  | { type: "user"; text: string }
  | { type: "assistant"; time: { completed?: number }; content: ReadonlyArray<{ type: string; text?: string }>; error?: unknown }
  | { type: string };

export type ForkTurns = "none" | "all" | number;

export function parseForkTurns(value: unknown): ForkTurns {
  if (value === undefined || value === null || value === "" || value === "none") return "none";
  if (value === "all") return "all";
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(count) || count <= 0) throw new Error('fork_turns must be "none", "all", or a positive number of turns.');
  return count;
}

const isUser = (message: ContextMessage): message is Extract<ContextMessage, { type: "user" }> =>
  message.type === "user" && typeof (message as { text?: unknown }).text === "string";

const isAssistant = (message: ContextMessage): message is Extract<ContextMessage, { type: "assistant"; content: unknown }> =>
  message.type === "assistant" && Array.isArray((message as { content?: unknown }).content);

/** The text parts of an assistant message, joined; reasoning and tool calls are left out. */
export function assistantText(message: ContextMessage): string {
  if (!isAssistant(message)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text)
    .join("\n\n");
}

/** The newest completed assistant message with text, which is a child's report. */
export function latestReport(messages: readonly ContextMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (!isAssistant(message) || message.time.completed === undefined) continue;
    const text = assistantText(message);
    if (text) return text;
  }
  return undefined;
}

/** The error on the newest assistant message, when the last run failed. */
export function latestError(messages: readonly ContextMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (!isAssistant(message)) continue;
    const error = message.error as { message?: unknown; data?: { message?: unknown } } | undefined;
    if (!error) return undefined;
    const text = error.message ?? error.data?.message;
    return typeof text === "string" && text ? text : JSON.stringify(error);
  }
  return undefined;
}

/**
 * A transcript of user messages and completed assistant text for a new child. Tool calls, tool results, reasoning,
 * and the parent's unfinished turn are left out, so the child inherits the conversation but no half-done protocol.
 */
export function forkTranscript(messages: readonly ContextMessage[], turns: ForkTurns): string | undefined {
  if (turns === "none") return undefined;
  const lines: { role: "user" | "assistant"; text: string }[] = [];
  for (const message of messages) {
    if (isUser(message) && message.text.trim()) lines.push({ role: "user", text: message.text.trim() });
    else if (isAssistant(message) && message.time.completed !== undefined) {
      const text = assistantText(message).trim();
      if (text) lines.push({ role: "assistant", text });
    }
  }
  let start = 0;
  if (turns !== "all") {
    let seen = 0;
    start = lines.length;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index]!.role !== "user") continue;
      start = index;
      if (++seen >= turns) break;
    }
  }
  const kept = lines.slice(start);
  if (kept.length === 0) return undefined;
  return kept.map((line) => `<${line.role}>\n${line.text}\n</${line.role}>`).join("\n");
}

/** The first prompt of a new child: the spawn notice, any copied conversation, then the task. */
export function buildChildPrompt(input: { prefix: string; task: string; transcript?: string }) {
  if (!input.transcript) return `${input.prefix}\n${input.task}`;
  return `${input.prefix}\n\n<parent_conversation>\n${input.transcript}\n</parent_conversation>\n\nTask:\n${input.task}`;
}