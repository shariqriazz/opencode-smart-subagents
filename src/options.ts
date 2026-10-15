export type Delivery = "steer" | "queue";

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface Settings {
  /** Running children allowed per parent session. */
  maxConcurrent: number;
  /** How a child's report enters the parent: at its next step, or after its current run. */
  resultDelivery: Delivery;
}

export const DEFAULT_MAX_CONCURRENT = 16;
const MAX_CONCURRENT_LIMIT = 50;

/** Parses "providerID/modelID" or "providerID/modelID#variant"; the model ID may itself contain slashes. */
export function parseModelRef(value: string): ModelRef | undefined {
  const [ref, variant, extra] = value.trim().split("#");
  if (extra !== undefined || !ref) return undefined;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Reads plugin options. Invalid values fall back to defaults and are reported through `warn`. */
export function readSettings(options: unknown, warn: (message: string) => void): Settings {
  const input = isRecord(options) ? options : {};
  const settings: Settings = { maxConcurrent: DEFAULT_MAX_CONCURRENT, resultDelivery: "steer" };

  if (input.maxConcurrent !== undefined) {
    const value = input.maxConcurrent;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENT_LIMIT) settings.maxConcurrent = value;
    else warn(`maxConcurrent must be an integer from 1 to ${MAX_CONCURRENT_LIMIT}; using ${DEFAULT_MAX_CONCURRENT}`);
  }
  if (input.resultDelivery !== undefined) {
    if (input.resultDelivery === "steer" || input.resultDelivery === "queue") settings.resultDelivery = input.resultDelivery;
    else warn('resultDelivery must be "steer" or "queue"; using "steer"');
  }
  return settings;
}