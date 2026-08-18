import { z } from "zod";

/** QQ 号码：5–11 位数字，第一位不为 0。 */
export const qqSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{4,10}$/, "请输入 5–11 位数字的 QQ 号码。");

/** 头像来源：none 默认（无头像）、qq 使用 QQ 头像、uploaded 使用已上传头像。 */
export const profileAvatarSourceSchema = z.enum(["none", "qq", "uploaded"]);

export const profileAccountTypeSchema = z.enum(["human", "robot"]);

/** 仅本人可见的个人资料视图。 */
export const profileViewSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  accountType: profileAccountTypeSchema,
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  /** 仅本人可见；其他用户永远看不到。 */
  qq: qqSchema.nullable(),
  avatarSource: profileAvatarSourceSchema,
  /** 站内头像地址；无头像时为 null，客户端用默认头像兜底。 */
  avatarUrl: z.string().nullable(),
  /** 学号/用户名等由外部身份映射来的标识，仅本人可见。 */
  studentIds: z.array(z.object({ attribute: z.string(), value: z.string() })),
});

export type ProfileView = z.infer<typeof profileViewSchema>;

/** 更新个人资料：空字符串的 qq 表示清除。
 * avatarSource 的切换规则由服务端校验（qq 需要已填写 qq，uploaded 需要已有上传头像）。
 */
export const updateProfileInputSchema = z
  .object({
    nickname: z.string().trim().min(1, "昵称不能为空。").max(120, "昵称最多 120 个字符。").optional(),
    qq: z
      .preprocess((value) => (value === "" ? null : value), qqSchema.nullable())
      .optional(),
    avatarSource: profileAvatarSourceSchema.optional()
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

export const avatarUploadResponseSchema = z.object({
  ok: z.literal(true),
  avatarSource: z.literal("uploaded"),
  avatarUrl: z.string()
});

export type AvatarUploadResponse = z.infer<typeof avatarUploadResponseSchema>;