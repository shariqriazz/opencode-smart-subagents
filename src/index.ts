import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin";
import { handleEvent, load, state, type Ctx } from "./coordinator.ts";
import { readSettings } from "./options.ts";
import { CHILD_SYSTEM_NOTE, CHILD_TOOLS, PARENT_TOOLS } from "./prompt.ts";
import { createTools } from "./tools.ts";

const PLUGIN_ID = "opencode-smart-subagents";
const warn = (message: string) => console.warn(`[${PLUGIN_ID}] ${message}`);

type SkillEditor = Parameters<Parameters<Ctx["skill"]["transform"]>[0]>[0];
type SkillInfo = Parameters<SkillEditor["add"]>[0];

/** A bundled skill: `name` and `description` from its frontmatter, and the body as its content. */
export function readSkill(relative: string): SkillInfo {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  const source = readFileSync(file, "utf8");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file} has no frontmatter`);
  const field = (key: string) => match[1]!.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const name = field("name");
  const description = field("description");
  if (!name || !description) throw new Error(`${file} needs a name and description`);
  return { id: name, name, description, path: file, content: match[2]!.trim() } as SkillInfo;
}

/**
 * Two-way subagents for OpenCode. The plugin replaces OpenCode's `subagent` tool with a compatible superset (same
 * name, inputs, and result metadata) and adds tools to steer, inspect, stop, and integrate children. Children get
 * tools to message and question their parent and each other.
 */
export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const shared = state();
    const settings = readSettings(ctx.options, warn);
    shared.delivery = settings.resultDelivery;
    shared.contexts.add(ctx);
    void load(ctx);

    const { tools, isChild } = createTools(ctx);
    const skill = readSkill("../skills/smart-subagents/SKILL.md");

    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
    await ctx.skill.transform((editor) => editor.add(skill));

    await ctx.session.hook("context", async (event) => {
      // Children OpenCode starts itself, such as slash-command subagents, report through OpenCode and get no child tools.
      await load(ctx).catch(() => undefined);
      const tracked = shared.records.has(event.sessionID);
      const child = tracked || (await isChild(event.sessionID).catch(() => false));
      if (child) for (const name of PARENT_TOOLS) delete event.tools[name];
      if (!tracked) for (const name of CHILD_TOOLS) delete event.tools[name];
      if (tracked) event.system.push({ type: "text", text: CHILD_SYSTEM_NOTE });
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) handleEvent(ctx, event as Parameters<typeof handleEvent>[1]);
    })().catch((error) => {
      if (!controller.signal.aborted) warn(`event stream stopped: ${String(error)}`);
    });

    return () => {
      controller.abort();
      shared.contexts.delete(ctx);
    };
  },
} satisfies Plugin.Plugin;