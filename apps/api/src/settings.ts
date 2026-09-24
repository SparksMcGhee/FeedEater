import { prisma } from "@feedeater/db";
import type { Request, Response } from "express";

import { decryptSecret, encryptSecret } from "./crypto.js";

export async function getModuleSettings(req: Request, res: Response) {
  const moduleName = String(req.params.module);
  const rows = await prisma.setting.findMany({
    where: { module: moduleName },
    orderBy: { key: "asc" },
  });

  res.json({
    module: moduleName,
    settings: rows.map((r) => ({
      key: r.key,
      isSecret: r.isSecret,
      value: r.isSecret ? null : r.value,
    })),
  });
}

function requireInternalAuth(req: Request): void {
  const expected = process.env.FEED_INTERNAL_TOKEN;
  if (!expected) throw new Error("Missing required env var: FEED_INTERNAL_TOKEN");

  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || token !== expected) {
    const err = new Error("Unauthorized");
    (err as any).statusCode = 401;
    throw err;
  }
}

export async function getModuleSettingsInternal(req: Request, res: Response) {
  requireInternalAuth(req);

  const moduleName = String(req.params.module);
  const rows = await prisma.setting.findMany({
    where: { module: moduleName },
    orderBy: { key: "asc" },
  });

  res.json({
    module: moduleName,
    settings: rows.map((r) => ({
      key: r.key,
      isSecret: r.isSecret,
      value: r.isSecret ? decryptSecret(r.value) : r.value,
    })),
  });
}

export async function putModuleSetting(req: Request, res: Response) {
  const moduleName = String(req.params.module);
  const key = String(req.params.key);

  const body = (req.body ?? {}) as { value?: unknown; isSecret?: unknown };
  if (typeof body.value !== "string") {
    res.status(400).json({ error: "value must be a string" });
    return;
  }

  const isSecret = body.isSecret === true;
  const valueToStore = isSecret ? encryptSecret(body.value) : body.value;

  const row = await prisma.setting.upsert({
    where: { module_key: { module: moduleName, key } },
    create: { module: moduleName, key, isSecret, value: valueToStore },
    update: { isSecret, value: valueToStore },
  });

  res.json({
    module: moduleName,
    key: row.key,
    isSecret: row.isSecret,
    value: row.isSecret ? null : row.value,
  });
}
