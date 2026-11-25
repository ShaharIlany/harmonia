import { expect, test } from "bun:test";
import { overrideArgs, SMALL_JOB } from "./runner";

test("a small job adds sonnet at medium effort, a normal one adds nothing", () => {
  expect(overrideArgs(SMALL_JOB.model, SMALL_JOB.effort)).toEqual(["--model", "sonnet", "--effort", "medium"]);
  expect(overrideArgs()).toEqual([]);
});
