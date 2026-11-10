import { z } from "zod";

export const UpdateNotificationSettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  soundEnabled: z.boolean().optional(),
  vibrationEnabled: z.boolean().optional(),
  showPreview: z.boolean().optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: z.string().optional(),
  quietHoursEnd: z.string().optional(),
  quietHoursTz: z.string().optional(),
  eventSettings: z.record(z.any()).optional(),
});

export type UpdateNotificationSettingsInput = z.infer<typeof UpdateNotificationSettingsSchema>;