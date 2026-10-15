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

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}