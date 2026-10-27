/**
 * 待发附件 → 命令载荷(`ConversationSendMessage.attachments`)的形状契约。
 *
 * 两个错误都不会报错、只会静默丢东西:空数组被当成"带了附件"发上线,
 * 或者非数组被当成引用透传。这里把两种输入都钉死。
 */
import { describe, expect, test } from "vitest";
import { attachmentRefsOf } from "../src/lib/transport/backend";

const ref = {
  content_id: "sha256:9f2c1a",
  media_type: "image/png",
  sha256: "sha256:9f2c1a",
  truncated: false,
};

describe("attachmentRefsOf:字段名对齐生成绑定,空集合不上线", () => {
  test("非空数组原样取出(字段名 = ContentRef 生成绑定的 snake_case)", () => {
    expect(attachmentRefsOf({ attachments: [ref] })).toEqual([ref]);
  });

  test("空数组/缺失/类型漂移一律 null——`attachments: []` 会白白往线上塞一个空字段", () => {
    expect(attachmentRefsOf({ attachments: [] })).toBeNull();
    expect(attachmentRefsOf({})).toBeNull();
    expect(attachmentRefsOf({ attachments: null })).toBeNull();
    expect(attachmentRefsOf({ attachments: "sha256:9f2c1a" })).toBeNull();
  });
});
