import { expect, test } from "vitest";
import { truncateDisplayColumns } from "../src/lib/strings";

test("恰好 20 列不截断:10 个汉字 / 20 个英文字符", () => {
  expect(truncateDisplayColumns("一二三四五六七八九十", 20)).toBe("一二三四五六七八九十");
  expect(truncateDisplayColumns("abcdefghijklmnopqrst", 20)).toBe("abcdefghijklmnopqrst");
});

test("超长补「…」:第 11 个汉字 / 第 21 个英文字符触发", () => {
  expect(truncateDisplayColumns("一二三四五六七八九十十一", 20)).toBe("一二三四五六七八九十…");
  expect(truncateDisplayColumns("abcdefghijklmnopqrstu", 20)).toBe("abcdefghijklmnopqrst…");
});

test("混合文本按显示列宽计:全角 2 列、半角 1 列", () => {
  // 3 + 4 + 12 = 19 列,不截断
  expect(truncateDisplayColumns("abc中文defghijklmno", 20)).toBe("abc中文defghijklmno");
  // 全角标点也是 2 列
  expect(truncateDisplayColumns("一二三四五六七八九，", 20)).toBe("一二三四五六七八九，");
  expect(truncateDisplayColumns("一二三四五六七八九十，", 20)).toBe("一二三四五六七八九十…");
});

test("emoji 按宽格计 2 列(代理对整体保留)", () => {
  expect(truncateDisplayColumns("✅✅✅✅✅✅✅✅✅✅", 20)).toBe("✅✅✅✅✅✅✅✅✅✅");
  expect(truncateDisplayColumns("✅✅✅✅✅✅✅✅✅✅✅", 20)).toBe("✅✅✅✅✅✅✅✅✅✅…");
});

test("边界:空串与 0 上限", () => {
  expect(truncateDisplayColumns("", 20)).toBe("");
  expect(truncateDisplayColumns("abc", 0)).toBe("");
});
