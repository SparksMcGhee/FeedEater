import { JobRunEventSchema, jobSubjectFor } from "@feedeater/core";
import { prisma } from "@feedeater/db";
import type { Request, Response } from "express";
import type { NatsConnection, StringCodec } from "nats";

import { discoverModules } from "./modules.js";

type RunJobBody = {
  module?: unknown;
  job?: unknown;
};

type ModuleManifest = Awaited<ReturnType<typeof discoverModules>>[number];

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

export function postRunJob(params: {
  modulesDir: string;
  getNatsConn: () => Promise<NatsConnection>;
  sc: StringCodec;
}) {
  return async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as RunJobBody;
      const moduleName = isNonEmptyString(body.module) ? body.module.trim() : "";
      const jobName = isNonEmptyString(body.job) ? body.job.trim() : "";
      if (!moduleName || !jobName) {
        res
          .status(400)
          .json({ ok: false, error: "Body must include { module: string, job: string }" });
        return;
      }

      const modules = await discoverModules(params.modulesDir);
      const mod = modules.find((m: ModuleManifest) => m.name === moduleName);
      if (!mod) {
        res.status(404).json({ ok: false, error: `Unknown module: ${moduleName}` });
        return;
      }

      const job = (mod.jobs ?? []).find((j) => j.name === jobName);
      if (!job) {
        res.status(404).json({ ok: false, error: `Unknown job: ${moduleName}.${jobName}` });
        return;
      }

      const runId = crypto.randomUUID();
      await prisma.jobRun.create({
        data: {
          id: runId,
          module: moduleName,
          job: job.name,
          queue: job.queue,
          status: "queued",
          triggerType: "manual",
          triggerJson: { manual: true },
        },
      });

      const payload = JobRunEventSchema.parse({
        type: "JobRun",
        module: moduleName,
        queue: job.queue,
        job: job.name,
        requestedAt: new Date().toISOString(),
        runId,
        trigger: { type: "manual" },
        data: { manual: true },
      });

      const nc = await params.getNatsConn();
      const subject = jobSubjectFor({ moduleName, queue: job.queue, job: job.name });
      nc.publish(subject, params.sc.encode(JSON.stringify(payload)));

      res.json({ ok: true, jobId: runId, queue: job.queue, job: job.name, module: moduleName });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function getJobsStatus(params: { modulesDir: string }) {
  return async (_req: Request, res: Response) => {
    try {
      const modules = await discoverModules(params.modulesDir);
      const states = await prisma.jobState.findMany();
      const stateByKey = new Map(states.map((s) => [`${s.module}.${s.job}`, s]));

      const jobs = [];
      for (const m of modules) {
        for (const j of m.jobs ?? []) {
          const key = `${m.name}.${j.name}`;
          const state = stateByKey.get(key);
          const lastRun = await prisma.jobRun.findFirst({
            where: { module: m.name, job: j.name },
            orderBy: { createdAt: "desc" },
            select: { status: true, createdAt: true },
          });
          jobs.push({
            module: m.name,
            job: j.name,
            queue: j.queue,
            schedule: j.schedule ?? null,
            triggeredBy: j.triggeredBy ?? null,
            lastRunAt: state?.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
            lastErrorAt: state?.lastErrorAt?.toISOString() ?? null,
            lastError: state?.lastError ?? null,
            lastMetrics: state?.lastMetrics ?? null,
            lastStatus: lastRun?.status ?? null,
            lastRunCreatedAt: lastRun?.createdAt?.toISOString?.() ?? null,
          });
        }
      }

      res.json({ ok: true, jobs });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}
