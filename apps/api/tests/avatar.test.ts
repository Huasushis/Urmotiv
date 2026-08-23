import { describe, expect, it } from "vitest";
import {
  avatarMaxBytes,
  detectAvatarMediaType,
  fetchQqAvatar,
  qqAvatarCdnUrl,
} from "../src/avatar";

const jpegBytes = (extra: number[] = []): Uint8Array =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...extra]);
const pngBytes = (extra: number[] = []): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);
const webpBytes = (extra: number[] = []): Uint8Array =>
  new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ...extra,
  ]);

describe("头像类型识别", () => {
  it("按文件头识别 JPEG、PNG 与 WebP", () => {
    expect(detectAvatarMediaType(jpegBytes([1, 2, 3]))).toBe("image/jpeg");
    expect(detectAvatarMediaType(pngBytes([1, 2, 3]))).toBe("image/png");
    expect(detectAvatarMediaType(webpBytes([1, 2, 3]))).toBe("image/webp");
  });

  it("空内容、超限内容或不支持的字节都返回 undefined", () => {
    expect(detectAvatarMediaType(new Uint8Array())).toBeUndefined();
    const content = pngBytes();
    const oversized = new Uint8Array(avatarMaxBytes + 1);
    oversized.set(content);
    expect(detectAvatarMediaType(oversized)).toBeUndefined();
    expect(detectAvatarMediaType(new TextEncoder().encode("这不是图片"))).toBeUndefined();
    // GIF/伪装文件头也不接受。
    expect(detectAvatarMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeUndefined();
  });
});

describe("QQ 头像服务端抓取", () => {
  it("固定 CDN 地址只包含编码后的 QQ 号码，不拼接其他参数", () => {
    expect(qqAvatarCdnUrl("123456789")).toBe("https://q2.qlogo.cn/g?b=qq&nk=123456789&s=100");
    expect(qqAvatarCdnUrl("88 88")).toContain(encodeURIComponent("88 88"));
  });

  it("返回受支持图片时按实际文件头限定类型并返回字节", async () => {
    const png = Buffer.from(pngBytes([9, 9]));
    const fetchImpl: typeof fetch = async () => new Response(png, { status: 200 });
    const result = await fetchQqAvatar("123456789", fetchImpl);
    expect(result).toEqual({ mediaType: "image/png", content: new Uint8Array(png) });
  });

  it("200 但内容不是受支持图片、返回非 2xx、超限或网络异常时都以无头像处理", async () => {
    const junkFetch: typeof fetch = async () =>
      new Response(new TextEncoder().encode("不是图片"), { status: 200 });
    expect(await fetchQqAvatar("1", junkFetch)).toBeUndefined();

    const failingFetch: typeof fetch = async () => new Response("boom", { status: 502 });
    expect(await fetchQqAvatar("2", failingFetch)).toBeUndefined();

    const tooLarge = pngBytes();
    const body = Buffer.concat([Buffer.from(tooLarge), Buffer.alloc(avatarMaxBytes + 1)]);
    const largeFetch: typeof fetch = async () => new Response(body, { status: 200 });
    expect(await fetchQqAvatar("3", largeFetch)).toBeUndefined();

    const throwingFetch: typeof fetch = async () => {
      throw new Error("synthetic QQ CDN transport failure");
    };
    expect(await fetchQqAvatar("4", throwingFetch)).toBeUndefined();
  });
});
