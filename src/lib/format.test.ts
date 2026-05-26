import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("returns 0 B for zero and negative values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("formats bytes without decimals", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("rounds small KB values to one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("drops decimals at 10+ in a unit", () => {
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  });

  it("scales up to TB without overflowing the units array", () => {
    const tb = 1024 ** 4;
    expect(formatBytes(tb)).toBe("1.0 TB");
    expect(formatBytes(tb * 1024 * 10)).toMatch(/TB$/);
  });
});
