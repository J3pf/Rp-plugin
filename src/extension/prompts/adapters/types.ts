import type { Answer } from "../../../shared/protocol.ts";
import type { AdapterPromptSpec } from "../broker.ts";

/** Knows the parameters and the result type of one custom()-based tool (PLAN §8.5). */
export interface CustomDialogAdapter {
  /** Tool name this adapter handles. */
  readonly tool: string;
  readonly extension: string;
  /** Validate that the call args have the shape this adapter was written for; false → adapter is skipped. */
  accepts(args: unknown): boolean;
  toPrompt(args: unknown): AdapterPromptSpec;
  /** Phone Answer → the value the tool's custom() expects through its `done(...)`. */
  toResult(args: unknown, answer: Answer): unknown;
  /** The tool's custom() result (from the terminal) → Answer for prompt.resolved. */
  fromResult(args: unknown, result: unknown): Answer;
}
