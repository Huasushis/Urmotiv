import type { ProfileView, UpdateProfileInput } from "@urmotiv/contracts";
import { detectAvatarMediaType, fetchQqAvatar, type AvatarMediaType } from "./avatar";
import type { StoredUser } from "./domain";
import { conflict, forbidden, notFound, unauthorized } from "./errors";
import type { DataStore } from "./repository";

export function avatarUrlPath(userId: string): string {
  return `/api/v1/users/${encodeURIComponent(userId)}/avatar`;
}

export function avatarSourceOf(user: StoredUser): "none" | "qq" | "uploaded" {
  return user.avatarSource ?? "none";
}

/** 只有已登录的普通账号可以维护个人资料；机器人等账号一律拒绝。 */
export function requireEditableProfile(actor: StoredUser | undefined): StoredUser {
  if (actor === undefined) {
    throw unauthorized();
  }
  if (actor.accountType !== "human") {
    throw forbidden("机器人账号不能维护个人资料。");
  }
  return actor;
}

export async function readProfileView(user: StoredUser, store: DataStore): Promise<ProfileView> {
  const [email, studentIds] = await Promise.all([
    store.getPrimaryEmail(user.id),
    store.listUserIdentifiers(user.id)
  ]);
  return {
    id: user.id,
    nickname: user.nickname,
    accountType: user.accountType,
    email: email?.address ?? null,
    emailVerified: email?.verified ?? false,
    qq: user.qq ?? null,
    avatarSource: avatarSourceOf(user),
    avatarUrl: avatarSourceOf(user) === "none" ? null : avatarUrlPath(user.id),
    studentIds: studentIds.map((item) => ({ attribute: item.attribute, value: item.value }))
  };
}

export async function updateOwnProfile(
  actor: StoredUser | undefined,
  input: UpdateProfileInput,
  store: DataStore
): Promise<ProfileView> {
  const currentUser = requireEditableProfile(actor);
  const current = await store.getUser(currentUser.id);
  if (current === undefined) {
    throw notFound();
  }
  const patch: {
    nickname?: string;
    qq?: string | null;
    avatarSource?: "none" | "qq" | "uploaded";
  } = {};
  if (input.nickname !== undefined) {
    patch.nickname = input.nickname;
  }
  if (input.qq !== undefined) {
    patch.qq = input.qq;
    if (input.qq === null && (input.avatarSource ?? current.avatarSource) === "qq") {
      // 清除 QQ 号码时同步退出 QQ 头像，避免数据库约束失败。
      patch.avatarSource = "none";
    }
  }
  if (input.avatarSource !== undefined) {
    if (input.avatarSource === "qq" && !(patch.qq ?? current.qq)) {
      throw conflict("使用 QQ 头像前请先填写 QQ 号码。");
    }
    if (input.avatarSource === "uploaded") {
      const existing = await store.getUserAvatar(current.id);
      if (existing === undefined) {
        throw conflict("还没有上传头像，无法选择已上传头像。");
      }
    }
    patch.avatarSource = input.avatarSource;
  }
  const updated = await store.updateUserProfile(current.id, patch);
  if (updated === undefined) {
    throw notFound();
  }
  return readProfileView(updated, store);
}

export async function uploadOwnAvatar(
  actor: StoredUser | undefined,
  content: Uint8Array,
  store: DataStore
): Promise<ProfileView> {
  const currentUser = requireEditableProfile(actor);
  const mediaType = detectAvatarMediaType(content);
  if (mediaType === undefined) {
    throw conflict(
      "不支持的头像文件。只接受不超过 512 KB 的 JPEG、PNG 或 WebP 图片。"
    );
  }
  const updated = await store.setUserAvatar(currentUser.id, mediaType, content);
  if (updated === undefined) {
    throw notFound();
  }
  return readProfileView(updated, store);
}

export async function clearOwnAvatar(
  actor: StoredUser | undefined,
  store: DataStore
): Promise<ProfileView> {
  const currentUser = requireEditableProfile(actor);
  const updated = await store.clearUserAvatar(currentUser.id);
  if (updated === undefined) {
    throw notFound();
  }
  return readProfileView(updated, store);
}

export type AvatarResponse =
  | { readonly kind: "none" }
  | { readonly kind: "uploaded"; readonly mediaType: string; readonly content: Uint8Array }
  | { readonly kind: "qq"; readonly mediaType: string; readonly content: Uint8Array };

/**
 * 解析目标用户当前头像的最终可展示内容。uploaded 直接返回已存字节；
 * qq 从固定 CDN 抓取（失败时按“无头像”处理，客户端用默认头像兜底）。
 * 不可见或不存在的一律返回 none，避免泄露用户是否存在。
 */
export async function resolveAvatarResponse(
  targetUserId: string,
  store: DataStore,
  fetchImpl: typeof fetch
): Promise<AvatarResponse> {
  const target = await store.getUser(targetUserId);
  if (target === undefined || target.accountType !== "human") {
    return { kind: "none" };
  }
  const source = avatarSourceOf(target);
  if (source === "none") {
    return { kind: "none" };
  }
  if (source === "uploaded") {
    const avatar = await store.getUserAvatar(targetUserId);
    if (avatar === undefined) {
      return { kind: "none" };
    }
    return { kind: "uploaded", mediaType: avatar.mediaType, content: avatar.content };
  }
  if (!target.qq) {
    return { kind: "none" };
  }
  const fetched = await fetchQqAvatar(target.qq, fetchImpl);
  if (fetched === undefined) {
    return { kind: "none" };
  }
  return { kind: "qq", mediaType: fetched.mediaType, content: fetched.content };
}