import { describe, expect, it } from "vitest";
import { parseMoneyToMinor } from "./money";

describe("parseMoneyToMinor", () => {
  it.each([
    ["1.234,56 zł", 123456],
    ["1,234.56", 123456],
    ["1 234,5", 123450],
    ["-99,99", -9999],
    ["1.234", 123400],
  ])("parses %s", (source, expected) => {
    expect(parseMoneyToMinor(source)).toBe(expected);
  });
});
