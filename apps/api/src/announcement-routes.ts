import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  announcementInputSchema,
  updateAnnouncementSchema,
} from "@urmotiv/contracts";
import { ApiError } from "./errors";
import type { AnnouncementService } from "./announcement-service";
export function registerAnnouncementRoutes(
  app: FastifyInstance,
  options: {
    service?: AnnouncementService;
    userId: (request: FastifyRequest, manage: boolean) => Promise<string>;
  },
) {
  const service = () => {
    if (!options.service)
      throw new ApiError(
        503,
        "ANNOUNCEMENTS_UNAVAILABLE",
        "当前存储未启用公告。",
      );
    return options.service;
  };
  const query = z
    .object({
      page: z.coerce.number().int().min(1).max(1000000).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
      popup: z.enum(["1", "0"]).optional(),
    })
    .strict();
  for (const manage of [false, true])
    app.get(
      manage ? "/api/v1/admin/announcements" : "/api/v1/announcements",
      async (request) => {
        const id = await options.userId(request, manage);
        const input = query.parse(request.query);
        return service().list(id, {
          ...input,
          manage,
          popup: input.popup === "1",
        });
      },
    );
  app.get("/api/v1/admin/announcements/roles", async (request) => {
    const userId=await options.userId(request,true);
    return service().roles(userId);
  });
  app.post("/api/v1/admin/announcements", async (request) => {
    const id = await options.userId(request, true);
    return service().save(
      id,
      announcementInputSchema.parse(request.body),
      request.id,
    );
  });
  app.put("/api/v1/admin/announcements/:id", async (request) => {
    const actor = await options.userId(request, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedRevision, ...input } = updateAnnouncementSchema.parse(
      request.body,
    );
    return service().save(actor, input, request.id, id, expectedRevision);
  });
  app.post("/api/v1/announcements/:id/read", async (request) => {
    const actor = await options.userId(request, false);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { revision } = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(request.body);
    return service().markRead(actor, id, revision);
  });
}
