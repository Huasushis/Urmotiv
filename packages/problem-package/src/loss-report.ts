import { z } from "zod";

export const lossSeverities = ["error", "choice", "warning", "info"] as const;

export const lossReportItemSchema = z.object({
  severity: z.enum(lossSeverities),
  path: z.string().trim().min(1).max(500),
  message: z.string().trim().min(1).max(2_000)
});

export const lossReportSchema = z.object({
  targetFormat: z.string().trim().min(1).max(120),
  canExport: z.boolean(),
  items: z.array(lossReportItemSchema)
});

export type LossReportItem = z.infer<typeof lossReportItemSchema>;
export type LossReport = z.infer<typeof lossReportSchema>;

/**
 * `error` means the target cannot be produced. `choice` means the user must
 * choose a supported alternative before exporting. Warnings and notes can be
 * shown without stopping the export.
 */
export function createLossReport(
  targetFormat: string,
  items: readonly LossReportItem[]
): LossReport {
  const canExport = !items.some((item) => item.severity === "error" || item.severity === "choice");
  return lossReportSchema.parse({ targetFormat, canExport, items });
}
