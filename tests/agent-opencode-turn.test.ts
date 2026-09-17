import { describe, expect, it } from "vitest";
import { OpenCodeTurnTracker } from "../packages/agents/src/opencode-turn.ts";

const sessionID = "session-current";
const userMessageID = "user-current";
const user = { id: userMessageID, sessionID, role: "user" as const };
const assistant = (change: Record<string, unknown> = {}) => ({
  id: "assistant-current",
  sessionID,
  role: "assistant" as const,
  parentID: userMessageID,
  ...change,
});

describe("OpenCode turn reconciliation", () => {
  it("keeps a completion observed before the async acknowledgement pending until ACK", () => {
    const tracker = new OpenCodeTurnTracker(sessionID, userMessageID);
    tracker.observe({ type: "message.updated", properties: { info: user } });
    tracker.observe({
      type: "message.updated",
      properties: { info: assistant({ finish: "stop" }) },
    });
    tracker.observe({ type: "session.idle", properties: { sessionID } });
    expect(tracker.result).toBeUndefined();

    tracker.markAccepted();
    tracker.reconcile(undefined, undefined, true);
    expect(tracker.result).toMatchObject({ outcome: "success" });
  });

  it("does not treat an intermediate tool step as the end of the user turn", () => {
    const tracker = new OpenCodeTurnTracker(sessionID, userMessageID);
    tracker.markSubmissionStarted();
    tracker.observe({ type: "session.idle", properties: { sessionID } });
    tracker.markAccepted();
    tracker.observe({ type: "message.updated", properties: { info: user } });
    tracker.observe({
      type: "message.updated",
      properties: { info: assistant({ id: "assistant-tool", finish: "tool-calls" }) },
    });
    tracker.observe({
      type: "session.status",
      properties: { sessionID, status: { type: "busy" } },
    });
    expect(tracker.result).toBeUndefined();

    tracker.observe({
      type: "message.updated",
      properties: { info: assistant({ finish: "stop", cost: 1.5 }) },
    });
    tracker.reconcile(undefined, undefined, true);
    expect(tracker.result).toEqual({ outcome: "success", cost: 1.5 });
  });

  it("returns a real provider error only at the current turn's idle boundary", () => {
    const tracker = new OpenCodeTurnTracker(sessionID, userMessageID);
    tracker.markAccepted();
    tracker.observe({ type: "message.updated", properties: { info: user } });
    tracker.observe({
      type: "session.error",
      properties: { sessionID, error: { name: "ProviderAuthError", data: { message: "denied" } } },
    });
    expect(tracker.result).toBeUndefined();
    tracker.observe({
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } },
    });
    tracker.reconcile(undefined, undefined, true);
    expect(tracker.result).toMatchObject({
      outcome: "failed",
      error: { name: "ProviderAuthError" },
    });
  });

  it("stops safely before acknowledgement and after an accepted busy turn", () => {
    const beforeAck = new OpenCodeTurnTracker(sessionID, "user-before-ack");
    beforeAck.markSubmissionStarted();
    beforeAck.requestStop();
    beforeAck.reconcile({ type: "idle" }, []);
    expect(beforeAck.result).toBeUndefined();
    beforeAck.markAccepted();
    beforeAck.reconcile({ type: "idle" }, [
      { info: { id: "user-before-ack", sessionID, role: "user" } },
    ]);
    beforeAck.confirmStop();
    beforeAck.reconcile(undefined, [], true);
    expect(beforeAck.result).toEqual({ outcome: "stopped" });

    const afterAck = new OpenCodeTurnTracker(sessionID, userMessageID);
    afterAck.markAccepted();
    afterAck.observe({ type: "message.updated", properties: { info: user } });
    afterAck.observe({
      type: "session.status",
      properties: { sessionID, status: { type: "busy" } },
    });
    afterAck.requestStop();
    expect(afterAck.result).toBeUndefined();
    afterAck.confirmStop();
    afterAck.reconcile(undefined, [], true);
    expect(afterAck.result).toEqual({ outcome: "stopped" });
  });

  it("requires a post-ACK abort when the first abort races delayed server acceptance", () => {
    const tracker = new OpenCodeTurnTracker(sessionID, userMessageID);
    tracker.markSubmissionStarted();
    tracker.requestStop();
    // The first abort response arrived while promptAsync was still in flight.
    tracker.reconcile({ type: "idle" }, []);
    expect(tracker.result).toBeUndefined();

    // The delayed prompt is accepted after that response. A caller must issue
    // its second abort after this evidence, then wait for the new idle edge.
    tracker.markAccepted();
    tracker.reconcile({ type: "idle" }, [
      { info: { id: userMessageID, sessionID, role: "user" } },
      {
        info: {
          id: "assistant-current",
          sessionID,
          role: "assistant",
          parentID: userMessageID,
          finish: "stop",
        },
      },
    ]);
    expect(tracker.result).toBeUndefined();
    tracker.confirmStop();
    tracker.reconcile(undefined, [], true);
    expect(tracker.result).toEqual({ outcome: "stopped" });
  });
});
