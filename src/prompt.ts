/** Every string the model reads: tool and parameter descriptions, tool results, and injected guidance. */

export const PARENT_TOOLS = ["subagent", "subagent_batch", "subagent_message", "subagent_status", "subagent_stop", "subagent_apply"] as const;
export const CHILD_TOOLS = ["message_parent", "ask_parent", "list_peers", "message_peer"] as const;

/** OpenCode's own subagent plugin appends the list of available subagents to this description. */
export const SUBAGENT_DESCRIPTION = [
  "Start a subagent in a child session, or continue one by passing its sessionID.",
  "Delegate only when the user asks for subagents, delegation, or parallel work.",
  "Foreground (the default) waits for the child and returns its final report. With background=true the call returns at once and the report arrives later as a message; don't poll for it.",
  "A new child sees only its prompt unless fork_turns is set, so state the goal, relevant paths and facts, allowed scope, and the report you expect.",
  "While it works, a child can send you updates and questions. Steer it or answer with subagent_message.",
].join("\n");

export const BATCH_DESCRIPTION =
  "Start several independent background subagents at once. Either all of them start or none do. Each report arrives as its own message; don't poll for them.";

export const PARAM = {
  agent: "Subagent to run, from the list of available subagents.",
  description: "Short 3-5 word label shown to the user.",
  prompt: "Complete task: goal, context, paths, scope, and the report you expect.",
  sessionID: "Continue this child session instead of starting a new one. A running child takes the prompt mid-run.",
  background: "Return at once; the report arrives later as a message. Default false.",
  model:
    'Set only when the user asks for a specific model. Written as "providerID/modelID" or "providerID/modelID#variant". Default: the agent\'s model, otherwise yours.',
  forkTurns:
    'Your conversation to copy into a new child: "all" or a number of recent user turns. Default none. Use it only when that history matters to the task.',
  isolation:
    'Use "worktree" only when concurrent writers would overlap: the child then works in its own git worktree, which needs a clean checkout. Default none.',
  capability:
    '"read-only" (no edits or shell), "execute" (shell but no edits), "read-write" (edits but no shell), or "all". Default: the agent\'s own permissions.',
  tasks: "The subagents to start.",
  messageTarget: "Child sessionID.",
  message: "Guidance, an answer to its question, or the next task.",
  statusIDs: "Child sessionIDs whose latest output to include. Omit to list every child.",
  stopIDs: "Child sessionIDs to stop.",
  applyTarget: "SessionID of a child that ran with isolation worktree.",
  applyAction: "Default patch.",
  update: "The update or warning.",
  question: "The question, with the options you see when there are any.",
  peer: "Peer sessionID from list_peers.",
  peerMessage: "Message for the peer.",
} as const;

export const MESSAGE_DESCRIPTION =
  "Send a message to one of your subagents. It steers a running child, answers a child's question, or starts an idle child's next turn. The child's next report arrives as a message.";

export const STATUS_DESCRIPTION =
  "Show your subagents' status and pending questions, plus the latest output of any you name. It never waits. Use it when the user asks, when a child seems stuck, or when a coordination decision depends on it; results arrive on their own.";

export const STOP_DESCRIPTION = "Stop running subagents. Their sessions and partial work are kept, and they can be continued later.";

export const APPLY_DESCRIPTION =
  "Inspect, patch, cherry-pick, merge, or permanently discard the worktree of a finished subagent. Cherry-pick and merge are tried in a temporary worktree first, so a conflict leaves your checkout unchanged.";

export const MESSAGE_PARENT_DESCRIPTION =
  "Send your parent a short update or warning and keep working. It reaches the parent at its next step and does not wake an idle parent.";

export const ASK_PARENT_DESCRIPTION =
  "Ask your parent a question you need answered to continue. After calling it, end your turn; the answer arrives as your next message.";

export const LIST_PEERS_DESCRIPTION = "List the other subagents your parent started, with their status.";

export const MESSAGE_PEER_DESCRIPTION =
  "Send a message to another subagent your parent started. It steers a running peer or starts an idle peer's next turn.";

export const CHILD_SYSTEM_NOTE = [
  "You are a subagent working for a parent session, which sees only your final message and the messages you send it.",
  "Make your final message a complete report: what you did, what you found, what you verified, and anything left open.",
  "You cannot start subagents. When a decision belongs to the parent, ask with ask_parent and end your turn.",
].join(" ");

export const CHILD_PROMPT_PREFIX = "You are a subagent spawned by another session.";

const attr = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/"/g, "'");

export type ResultState = "completed" | "error" | "cancelled";

export function resultMessage(child: { id: string; description: string }, state: ResultState, text: string) {
  return `<subagent sessionID="${child.id}" state="${state}" description="${attr(child.description)}">\n${text}\n</subagent>`;
}

export function questionMessage(child: { id: string; description: string }, question: string) {
  return [
    `<subagent_question sessionID="${child.id}" description="${attr(child.description)}">`,
    question,
    "</subagent_question>",
    "The subagent is waiting. Answer with subagent_message, or ask the user when the decision needs their authority.",
  ].join("\n");
}

export function updateMessage(child: { id: string; description: string }, update: string) {
  return `<subagent_update sessionID="${child.id}" description="${attr(child.description)}">\n${update}\n</subagent_update>`;
}

export function peerMessage(from: { id: string; description: string }, message: string) {
  return `<peer_message sessionID="${from.id}" description="${attr(from.description)}">\n${message}\n</peer_message>`;
}

export function backgroundStarted(id: string, agent: string, worktree?: string) {
  return [
    `Started subagent ${id} (${agent}${worktree ? `, worktree ${worktree}` : ""}) in the background.`,
    "Its report will arrive as a message. Continue independent work or end your turn; don't poll for it or duplicate its work.",
  ].join("\n");
}

export function steered(verb: "Steered" | "Answered" | "Continued", id: string) {
  return `${verb} subagent ${id}. Its report will arrive as a message.`;
}

export function foregroundQuestion(id: string, question: string) {
  return [
    `<subagent_question sessionID="${id}">`,
    question,
    "</subagent_question>",
    "The subagent paused for your answer and now continues in the background. Answer with subagent_message; its report will arrive as a message.",
  ].join("\n");
}

export const NO_TEXT = "Subagent completed without a text response.";
