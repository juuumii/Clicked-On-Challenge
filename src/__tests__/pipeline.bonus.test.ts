import { describe, it, expect } from "vitest";
import { generate } from "../lib/pipeline";

/**
 * Bonus test — edge case: reviewPasses is called with the attempt number.
 * A review that passes only on attempt 0 (the very first check) should
 * complete with attempts === 0 and status "ok". This guards against
 * off-by-one errors in the revision loop (e.g. starting at 1, or
 * incrementing before the first check).
 */
describe("Bonus — revision loop attempt counter is correct", () => {
  it("reports attempts=0 and status ok when review passes on the first check", async () => {
    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => { /* succeeds */ },
      reviewPasses: (attempt) => attempt === 0,
    });
    expect(res.status).toBe("ok");
    expect(res.attempts).toBe(0);
  });

  it("reports attempts=1 when review requires exactly one revision", async () => {
    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => { /* succeeds */ },
      reviewPasses: (attempt) => attempt >= 1,
    });
    expect(res.status).toBe("ok");
    expect(res.attempts).toBe(1);
  });

  it("returns error and attempts <= MAX_REVISIONS even when hand-off also fails", async () => {
    // Both review failure and hand-off failure at once — the revision
    // cap should win and we should never reach advanceToNextStage.
    let handoffCalled = false;
    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => {
        handoffCalled = true;
        throw new Error("should not be reached");
      },
      reviewPasses: () => false,
    });
    expect(res.status).toBe("error");
    expect(res.attempts).toBeLessThanOrEqual(3);
    expect(handoffCalled).toBe(false);
  });
});