import type { Answer } from "../../../shared/protocol.ts";
import type { AdapterPromptSpec } from "../broker.ts";

/** Optional capability for custom dialogs whose prompt data lives on their returned component. */
export interface ComponentDialogAdapter {
  fromComponent(component: unknown): AdapterPromptSpec | null;
}

/** Version-dependent capabilities of the tool behind an adapter, resolved once per session. */
export interface AdapterCaps {
  /** gentle-pi >= 5.0.0 offers the free-text row unless `allowCustomResponse: false` (4.x needed `true`). */
  freeTextByDefault: boolean;
}

/** Fallback for adapters used without a session (tests, unknown gentle-pi version). */
export const DEFAULT_ADAPTER_CAPS: AdapterCaps = { freeTextByDefault: false };

/** Knows the parameters and the result type of one custom()-based tool (PLAN §8.5). */
export interface CustomDialogAdapter {
  /** Tool name this adapter handles. */
  readonly tool: string;
  readonly extension: string;
  /** Validate that the call args have the shape this adapter was written for; false → adapter is skipped. */
  accepts(args: unknown): boolean;
  toPrompt(args: unknown, caps?: AdapterCaps): AdapterPromptSpec;
  /** Phone Answer → the value the tool's custom() expects through its `done(...)`. */
  toResult(args: unknown, answer: Answer, caps?: AdapterCaps): unknown;
  /** The tool's custom() result (from the terminal) → Answer for prompt.resolved. */
  fromResult(args: unknown, result: unknown, caps?: AdapterCaps): Answer;
  /** Present only for adapters that can safely build a prompt from custom()'s returned component. */
  fromComponent?: ComponentDialogAdapter["fromComponent"];
}
