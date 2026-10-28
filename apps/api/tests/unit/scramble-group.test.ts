import { describe, expect, it } from "vitest";
import { groupProductionItems } from "../../src/modules/today/scramble-group.js";

describe("groupProductionItems", () => {
  it("packs greedily by max 3 with remainder 1", () => {
    expect(
      groupProductionItems([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }], { max: 3 }),
    ).toEqual([[{ id: "1" }, { id: "2" }, { id: "3" }], [{ id: "4" }]]);
  });

  it("returns empty for empty input", () => {
    expect(groupProductionItems([])).toEqual([]);
  });

  it("keeps singles when fewer than max", () => {
    expect(groupProductionItems([{ id: "a" }, { id: "b" }], { max: 3 })).toEqual([
      [{ id: "a" }, { id: "b" }],
    ]);
  });

  it("packs exact multiples", () => {
    expect(
      groupProductionItems(
        [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }, { id: "6" }],
        { max: 3 },
      ),
    ).toEqual([
      [{ id: "1" }, { id: "2" }, { id: "3" }],
      [{ id: "4" }, { id: "5" }, { id: "6" }],
    ]);
  });
});
