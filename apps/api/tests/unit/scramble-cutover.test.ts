import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  appMetadata,
  attempts,
  learningExamples,
  questions,
  reviewStates,
  reviewTasks,
} from "../../src/db/schema.js";
import { applyProductionScrambleCutover } from "../../src/modules/review/scramble-cutover.js";
import { seedExample, seedItem, seedQuestion, seedReviewState } from "../helpers/seed.js";
import { seedLegacyBoundTask } from "../helpers/seed.js";

const NOW = new Date("2026-10-28T04:00:00.000Z");
const TZ = "Asia/Shanghai";

describe("production_scramble_v1 cutover", () => {
  it("deletes old P/cloze Q+attempts, resets P, keeps U/PE, and is idempotent", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);

    const chunk = await seedItem(db, {
      id: "chunk-1",
      type: "chunk",
      target: "wear down",
      queueState: "started",
    });
    await seedExample(db, chunk, "personal", "Stress wears me down.", { pinned: 1 });
    await seedReviewState(db, chunk, "understanding", {
      difficulty: 5,
      stability: 40,
      reps: 3,
      nextReviewAt: "2026-10-30T00:00:00.000Z",
      lastReviewAt: "2026-10-20T00:00:00.000Z",
      correctStreak: 2,
    });
    await seedReviewState(db, chunk, "production", {
      difficulty: 5,
      stability: 25,
      reps: 4,
      nextReviewAt: "2026-10-20T00:00:00.000Z",
      lastReviewAt: "2026-10-15T00:00:00.000Z",
      correctStreak: 3,
    });
    const qid = await seedQuestion(db, chunk, {
      id: "old-prod",
      type: "production",
      promptText: "请造句",
      payloadJson: JSON.stringify({
        mustUse: "wear down",
        referenceAnswer: "Meetings wear me down.",
        acceptanceNotes: "ok",
      }),
      promptKey: "generate_production_prompt",
    });
    const clozeId = await seedQuestion(db, chunk, {
      id: "old-cloze",
      type: "cloze",
      promptText: "Meetings ____ me down.",
      payloadJson: JSON.stringify({ acceptedAnswers: ["wear"] }),
      promptKey: "generate_cloze",
    });
    db.insert(attempts)
      .values({
        id: "att-prod",
        learningItemId: chunk,
        questionId: qid,
        mode: "today",
        result: "pass",
        answerText: "Meetings wear me down.",
        createdAt: "2026-10-15T00:00:00.000Z",
      })
      .run();
    db.insert(attempts)
      .values({
        id: "att-cloze",
        learningItemId: chunk,
        questionId: clozeId,
        mode: "today",
        result: "fail",
        createdAt: "2026-10-14T00:00:00.000Z",
      })
      .run();
    const taskId = seedLegacyBoundTask(db, chunk, qid, NOW, TZ);
    // leave task incomplete

    const first = applyProductionScrambleCutover(db, NOW);
    expect(first.applied).toBe(true);

    expect(db.select().from(questions).where(eq(questions.type, "production")).all()).toHaveLength(0);
    expect(db.select().from(questions).where(eq(questions.type, "cloze")).all()).toHaveLength(0);
    expect(db.select().from(attempts).all()).toHaveLength(0);

    const pe = db.select().from(learningExamples).all();
    expect(pe.some((e) => e.kind === "personal")).toBe(true);

    const u = db
      .select()
      .from(reviewStates)
      .all()
      .find((r) => r.dimension === "understanding");
    expect(u?.stability).toBe(40);
    expect(u?.correctStreak).toBe(2);

    const p = db
      .select()
      .from(reviewStates)
      .all()
      .find((r) => r.dimension === "production");
    expect(p?.reps).toBe(0);
    expect(p?.stability).toBeNull();
    expect(p?.difficulty).toBeNull();
    expect(p?.nextReviewAt).not.toBeNull(); // reactivated +1d

    const task = db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
    expect(task?.canceledAt).not.toBeNull();

    expect(
      db.select().from(appMetadata).where(eq(appMetadata.key, "production_scramble_v1")).get(),
    ).toBeTruthy();

    const second = applyProductionScrambleCutover(db, NOW);
    expect(second.applied).toBe(false);
  });
});
