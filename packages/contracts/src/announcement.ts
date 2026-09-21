import { z } from "zod";
export const announcementInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(30000),
    audience: z.enum(["all", "newcomers", "roles"]).default("newcomers"),
    roleIds: z.array(z.string().uuid()).max(50).default([]),
    newcomerDays: z.number().int().min(1).max(365).default(30),
    pinned: z.boolean().default(false),
    popup: z.boolean().default(true),
    published: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => v.audience !== "roles" || v.roleIds.length > 0,
    "请选择至少一个接收权限组。",
  );
export const updateAnnouncementSchema = announcementInputSchema.safeExtend({
  expectedRevision: z.number().int().positive(),
});
export const announcementSchema = announcementInputSchema.safeExtend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  read: z.boolean(),
});
export const announcementListSchema = z
  .object({
    items: z.array(announcementSchema),
    total: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
  })
  .strict();
export type AnnouncementInput = z.infer<typeof announcementInputSchema>;
export type Announcement = z.infer<typeof announcementSchema>;
