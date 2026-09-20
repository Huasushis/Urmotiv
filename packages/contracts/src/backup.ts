import { z } from "zod";

export const backupSettingsInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
    address: z.string().trim().url().max(2048),
    username: z.string().max(512),
    password: z.string().min(1).max(4096).optional(),
    encryptionPassword: z.string().min(12).max(1024).optional(),
    intervalHours: z.number().int().min(1).max(720).nullable(),
  })
  .strict();
export const backupJobSchema = z
  .object({
    id: z.string().uuid(),
    operation: z.enum(["backup", "restore"]),
    status: z.enum(["running", "succeeded", "failed"]),
    phase: z.string().max(120),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    backupName: z.string().max(150).nullable(),
    safetyBackupName: z.string().max(150).nullable(),
    errorCode: z.string().max(100).nullable(),
    message: z.string().max(500).nullable(),
  })
  .strict();
export const backupSettingsViewSchema = z
  .object({
    available: z.boolean(),
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    address: z.string(),
    username: z.string(),
    passwordConfigured: z.boolean(),
    encryptionPasswordConfigured: z.boolean(),
    intervalHours: z.number().int().nullable(),
    verifiedAt: z.string().datetime().nullable(),
    lastAttemptAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    job: backupJobSchema.nullable(),
  })
  .strict();
export const backupListSchema = z
  .object({
    items: z.array(
      z
        .object({
          name: z.string(),
          bytes: z.number().nonnegative(),
          modifiedAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export const restoreBackupInputSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+\.urb$/)
      .max(150),
    encryptionPassword: z.string().min(1).max(1024),
    currentPassword: z.string().min(1).max(1024),
    confirmation: z.literal("恢复整个站点"),
  })
  .strict();
export type BackupSettingsInput = z.infer<typeof backupSettingsInputSchema>;
export type BackupSettingsView = z.infer<typeof backupSettingsViewSchema>;
export type BackupJob = z.infer<typeof backupJobSchema>;
