/**
 * 头像的格式与大小限制，以及可选的“QQ 头像”抓取。
 * 不依赖图片解码库：用文件头（magic bytes）识别 JPEG/PNG/WebP，
 * 并限制字节数，避免把任意内容当作图片保存或转发。
 */

export const avatarMaxBytes = 512 * 1024;
export const qqAvatarFetchTimeoutMs = 5_000;

export type AvatarMediaType = "image/jpeg" | "image/png" | "image/webp";

function hasPrefix(content: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > content.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (content[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

/** 按文件头识别图片类型；不是支持的图片时返回 undefined。 */
export function detectAvatarMediaType(content: Uint8Array): AvatarMediaType | undefined {
  if (content.length === 0 || content.length > avatarMaxBytes) {
    return undefined;
  }
  if (hasPrefix(content, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (hasPrefix(content, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (
    hasPrefix(content, 0, [0x52, 0x49, 0x46, 0x46]) &&
    hasPrefix(content, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return undefined;
}

/** QQ 头像 CDN 地址；QQ 号码只拼进服务器端请求，不暴露给浏览器。 */
export function qqAvatarCdnUrl(qq: string): string {
  return `https://q2.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=100`;
}

export interface FetchedAvatar {
  readonly mediaType: AvatarMediaType;
  readonly content: Uint8Array;
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    total += next.value.length;
    if (total > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * 从固定 QQ 头像 CDN 拉取并校验头像；网络失败、超时或内容不是受支持图片时返回
 * undefined（调用方回退到默认头像）。fetchImpl 便于在测试中注入。
 */
export async function fetchQqAvatar(
  qq: string,
  fetchImpl: typeof fetch
): Promise<FetchedAvatar | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), qqAvatarFetchTimeoutMs);
  try {
    const response = await fetchImpl(qqAvatarCdnUrl(qq), {
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) {
      return undefined;
    }
    const content = await readBounded(response, avatarMaxBytes);
    if (content === undefined) {
      return undefined;
    }
    const mediaType = detectAvatarMediaType(content);
    if (mediaType === undefined) {
      return undefined;
    }
    return { mediaType, content };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}