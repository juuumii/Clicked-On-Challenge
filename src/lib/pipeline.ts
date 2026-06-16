import { extractJson } from "./extract-json";
import { mockStream, type MockBehavior, type MockState, type TransientError } from "./anthropic-mock";

export interface GenerateInput {
  /** Drives the mock streaming client (see anthropic-mock.ts). */
  behavior: MockBehavior;
  /** Hands the finished draft to the next pipeline stage. May reject. */
  advanceToNextStage: () => Promise<void>;
  /** Returns true once the draft passes review. Scripted by callers/tests. */
  reviewPasses: (attempt: number) => boolean;
}

export interface GenerateResult {
  status: "ok" | "error";
  attempts: number;
}

export const MAX_REVISIONS = 3;
const MAX_STREAM_RETRIES = 5;

function isTransient(err: unknown): boolean {
  return (err as TransientError).status === 429;
}

/**
 * Runs one content-generation pass: stream a draft, extract it, revise until it
 * passes review, then hand off to the next stage.
 *
 * Fixes applied:
 *  1. advanceToNextStage errors are awaited and surfaced — a failed hand-off
 *     now returns status "error" instead of being silently swallowed.
 *  2. A truncated stream (extractJson throws) is treated as a retryable failure
 *     so the run recovers on the next attempt rather than crashing.
 *  3. Transient 429s are retried with a counter cap; the revision loop is
 *     bounded by MAX_REVISIONS and returns "error" when review never passes.
 */
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const state: MockState = { calls: 0 };

  // --- Stream + extract, with retry on transient errors or truncation ---
  let text: string | null = null;
  for (let attempt = 0; attempt < MAX_STREAM_RETRIES; attempt++) {
    try {
      const raw = await mockStream(input.behavior, state);
      extractJson(raw); // validate — throws if truncated
      text = raw;
      break;
    } catch (err) {
      const isLast = attempt === MAX_STREAM_RETRIES - 1;
      // Only retry on transient API errors or truncation (extractJson failure).
      // Re-throw immediately on anything unexpected on the last attempt.
      if (isLast || (!isTransient(err) && !(err instanceof SyntaxError) && !(err instanceof Error && err.message.includes("No fenced JSON")))) {
        if (isLast) {
          return { status: "error", attempts: 0 };
        }
        throw err;
      }
      // Transient or truncation — loop and retry
    }
  }

  if (text === null) {
    return { status: "error", attempts: 0 };
  }

  // --- Revision loop, bounded by MAX_REVISIONS ---
  let attempt = 0;
  while (!input.reviewPasses(attempt)) {
    if (attempt >= MAX_REVISIONS) {
      return { status: "error", attempts: attempt };
    }
    attempt += 1;
  }

  // --- Hand off to next stage; surface any failure ---
  try {
    await input.advanceToNextStage();
  } catch {
    return { status: "error", attempts: attempt };
  }

  return { status: "ok", attempts: attempt };
}
