export const CAPABILITIES = ["read-only", "execute", "read-write", "all"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

const deny = (action: string): PermissionRule => ({ action, resource: "*", effect: "deny" });

/**
 * Session rules that narrow a child's access. OpenCode evaluates session rules after the agent's rules and the last
 * match wins, so each mode only denies what it removes: `edit` covers the edit, write, and patch tools and `shell`
 * covers commands. Tools from MCP servers and other plugins keep the agent's permissions.
 */
export function capabilityRules(capability: Capability | undefined): PermissionRule[] {
  switch (capability) {
    case "read-only":
      return [deny("edit"), deny("shell")];
    case "execute":
      return [deny("edit")];
    case "read-write":
      return [deny("shell")];
    default:
      return [];
  }
}

/**
 * OpenCode's own session and worktree management tools, which children reach through code mode. Moving, renaming, or
 * creating and removing worktrees belongs to the parent and the plugin: a moved worktree child would leave its
 * isolation, and a child could rename its parent. Effective names are `<namespace>_<tool>`.
 */
export const CHILD_DENIED_TOOLS = ["opencode_session_move", "opencode_session_rename", "opencode_worktree_create", "opencode_worktree_remove"];

/** Every child's session rules: the management denials, then its capability. */
export function childRules(capability: Capability | undefined): PermissionRule[] {
  return [...CHILD_DENIED_TOOLS.map(deny), ...capabilityRules(capability)];
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}