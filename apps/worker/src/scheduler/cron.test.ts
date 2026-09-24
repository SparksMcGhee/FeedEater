import { describe, expect, it } from "vitest";
import { nextCronTime } from "./cron";

const at = (h: number, m: number, s = 0) => new Date(2026, 8, 24, h, m, s, 0);

describe("nextCronTime", () => {
  it("'*' fires the next minute with seconds zeroed", () => {
    expect(nextCronTime("* * * * *", at(10, 30, 45))).toEqual(at(10, 31));
  });

  it("step-minute pattern fires at the next multiple", () => {
    expect(nextCronTime(`*/5 * * * *`, at(10, 31))).toEqual(at(10, 35));
    expect(nextCronTime(`*/5 * * * *`, at(10, 35))).toEqual(at(10, 40));
    expect(nextCronTime(`*/15 * * * *`, at(10, 1))).toEqual(at(10, 15));
  });

  it("fixed minute fires later this hour or next", () => {
    expect(nextCronTime("15 * * * *", at(10, 2))).toEqual(at(10, 15));
    expect(nextCronTime("15 * * * *", at(10, 20))).toEqual(at(11, 15));
  });

  it("returns null for unsupported or invalid patterns", () => {
    expect(nextCronTime("*/5 */2 * * *", at(10, 0))).toBeNull(); // hour must be '*'
    expect(nextCronTime("0 9 * * *", at(10, 0))).toBeNull(); // daily time not supported
    expect(nextCronTime("* *", at(10, 0))).toBeNull(); // wrong field count
    expect(nextCronTime("*/0 * * * *", at(10, 0))).toBeNull(); // zero step
    expect(nextCronTime("61 * * * *", at(10, 0))).toBeNull(); // out-of-range minute
    expect(nextCronTime("abc * * * *", at(10, 0))).toBeNull(); // garbage minute
  });
});
