import { hostname } from "node:os";
import * as Sentry from "@sentry/node";
import { PgBoss } from "pg-boss";
import {
  getAiLimitsConfig,
  getDatabaseConfig,
  getErrorReportingConfig,
  getNotificationConfig,
  getOcrConfig,
  getUploadConfig,
  validateWorkerConfig,
} from "@/lib/config";
import { getDb, getPool } from "@/lib/db/client";
import { envValue } from "@/lib/env";
import { asError, sentryOptions } from "@/lib/error-reporting";
import { getDirectory } from "@/lib/directory/directory";
import type { SyncTrigger } from "@/lib/directory/sync";
import { SERVER_TIME_ZONE } from "@/lib/format";
import {
  DIRECTORY_SYNC_CRON,
  DISPATCH_INTERVAL_MS,
  EMAIL_INTAKE_CRON,
  WEBHOOK_RECONCILE_CRON,
  WEBHOOK_SYNC_CRON,
  PROCESS_INTERVAL_MS,
  QUEUES,
  REVIEW_REMINDERS_CRON,
  STORAGE_CLEANUP_CRON,
  SLACK_INTAKE_INTERVAL_MS,
  WATCH_CRON,
  WEEKLY_DIGEST_CRON,
} from "@/lib/jobs/queues";
import { startPolling } from "@/lib/jobs/poll";
import { openImapMailbox } from "@/lib/email/imap";
import { recordPersonalDigests, recordWeeklyDigests } from "@/lib/library/digest";
import { pollMailbox } from "@/lib/library/email-intake";
import { processDueSlackEvents } from "@/lib/library/slack-intake";
import { startProcessor } from "@/lib/library/pipeline";
import { cleanUpOriginals } from "@/lib/library/originals";
import { recordReviewReminders } from "@/lib/library/review";
import { ensureDefaultDocumentTypes, ensureDefaultTopicAreas } from "@/lib/library/taxonomy";
import { requestAllPublished, syncDue } from "@/lib/webhook/sync";
import { logger } from "@/lib/logger";
import { retrySlackLookups, startDispatcher } from "@/lib/notifications/dispatch";
import { createSettingsReader } from "@/lib/settings/runtime";
import { getSettingsKey } from "@/lib/settings/secret-box";
import { getStorage } from "@/lib/storage";
import { DEFAULT_HEARTBEAT_FILE, startHeartbeat } from "./heartbeat";
import { createWorkerIntegrations } from "./integrations";

interface DirectorySyncJob {
  trigger?: SyncTrigger;
}

async function main() {
  validateWorkerConfig();
  const sentry = sentryOptions(getErrorReportingConfig(), "worker");
  // The bundle has no node_modules to hook into at load time.
  if (sentry) Sentry.init({ ...sentry, enableRuntimeChannelInjection: false });
  const boss = new PgBoss({
    connectionString: getDatabaseConfig().DATABASE_URL,
    application_name: "library-worker-pgboss",
  });
  boss.on("error", (error) => {
    const { queue, worker } = error as { queue?: unknown; worker?: unknown };
    logger.error({
      err: error,
      queue: typeof queue === "string" ? queue : undefined,
      worker: typeof worker === "string" ? worker : undefined,
    }, "pg-boss error");
    Sentry.captureException(asError(error));
  });
  await boss.start();

  // The settings of Admin › Integrations, read at each use.
  const integrations = createWorkerIntegrations(createSettingsReader(getDb(), getSettingsKey()), getNotificationConfig(), getAiLimitsConfig());

  // The Keycloak directory syncs every 15 minutes and once at startup, so a
  // fresh deployment has people right away. pg-boss keeps schedules in the
  // database, so the manual directory removes the schedule.
  const directory = getDirectory();
  const sync = directory.sync;
  if (sync) {
    await boss.createQueue(QUEUES.directorySync, { retryLimit: 2, retryDelay: 60, expireInSeconds: 300 });
    await boss.schedule(QUEUES.directorySync, DIRECTORY_SYNC_CRON, { trigger: "schedule" }, { tz: SERVER_TIME_ZONE });
    await boss.work<DirectorySyncJob>(QUEUES.directorySync, async (jobs) => {
      for (const job of jobs) {
        const result = await sync.run(job.data?.trigger ?? "schedule");
        // A failed run is already recorded; failing the job lets pg-boss retry.
        if (result.status === "failed") throw new Error(result.error);
      }
    });
    await boss.send(QUEUES.directorySync, { trigger: "startup" });
  } else {
    await boss.unschedule(QUEUES.directorySync);
    if (await boss.getQueue(QUEUES.directorySync)) await boss.deleteQueuedJobs(QUEUES.directorySync);
  }

  // Slack lookups that failed a week ago are tried again.
  await boss.createQueue(QUEUES.watch, { retryLimit: 1, retryDelay: 60, expireInSeconds: 600 });
  await boss.schedule(QUEUES.watch, WATCH_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.watch, async () => {
    await retrySlackLookups(getDb(), await integrations.transports(), new Date());
  });

  // Review reminders: a week after the draft to its owner, 30 days to the maintainers.
  await boss.createQueue(QUEUES.reviewReminders, { retryLimit: 3, retryDelay: 300, expireInSeconds: 600 });
  await boss.schedule(QUEUES.reviewReminders, REVIEW_REMINDERS_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.reviewReminders, async () => {
    const result = await recordReviewReminders(getDb(), new Date());
    if (result.reminded + result.escalated > 0) logger.info(result, "review reminders recorded");
  });

  // Originals of deleted notes that storage did not delete at once.
  await boss.createQueue(QUEUES.storageCleanup, { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 });
  await boss.schedule(QUEUES.storageCleanup, STORAGE_CLEANUP_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.storageCleanup, async () => {
    // Without storage, the keys wait until storage is set up.
    const storage = getStorage();
    if (!storage) return;
    const deleted = await cleanUpOriginals(getDb(), storage);
    if (deleted > 0) logger.info({ deleted }, "originals deleted");
  });

  // The weekly digest, Mondays at 09:00: the library's channel and list, each
  // team's channel, and an email to everyone who follows tags.
  await boss.createQueue(QUEUES.weeklyDigest, { retryLimit: 3, retryDelay: 300, expireInSeconds: 600 });
  // A worker that is down on Monday at 09:00 (a restart, an update) sends the
  // digest when it is back: the next week's digest would not list these notes.
  // A late or second run records nothing twice (one message per ISO week).
  await boss.schedule(QUEUES.weeklyDigest, WEEKLY_DIGEST_CRON, {}, { tz: SERVER_TIME_ZONE, missed: "once" });
  await boss.work(QUEUES.weeklyDigest, async () => {
    const now = new Date();
    const result = await recordWeeklyDigests(getDb(), now, await integrations.digest());
    const personal = await recordPersonalDigests(getDb(), now);
    logger.info({ ...result, personal }, "weekly digest recorded");
  });

  // The intake mailbox, every 2 minutes, while the email intake is set up.
  // Each run signs in again with the current setting.
  const maxBytes = getUploadConfig().UPLOAD_MAX_MB * 1_048_576;
  await boss.createQueue(QUEUES.emailIntake, { retryLimit: 0, expireInSeconds: 600 });
  await boss.schedule(QUEUES.emailIntake, EMAIL_INTAKE_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.emailIntake, async () => {
    const intake = await integrations.emailIntake();
    if (!intake) return;
    const open = () =>
      openImapMailbox({
        url: intake.imapUrl,
        mailbox: intake.mailbox,
        doneMailbox: intake.doneMailbox,
        // Room for one file at the limit, base64-encoded, and the text around it.
        maxMessageBytes: Math.ceil(maxBytes * 1.4) + 1_048_576,
      });
    const counts = await pollMailbox({ db: getDb(), storage: getStorage(), maxBytes, domains: intake.domains }, open);
    if (Object.keys(counts).length > 0) logger.info(counts, "intake mailbox read");
  });

  // The webhook: changed notes every minute, everything compared nightly,
  // while the webhook is set up.
  const baseUrl = getNotificationConfig().LIBRARY_BASE_URL;
  await boss.createQueue(QUEUES.webhookSync, { retryLimit: 0, expireInSeconds: 300 });
  await boss.schedule(QUEUES.webhookSync, WEBHOOK_SYNC_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.webhookSync, async () => {
    const client = await integrations.webhookClient();
    if (!client) return;
    const counts = await syncDue({ db: getDb(), client, baseUrl });
    if (Object.keys(counts).length > 0) logger.info(counts, "webhook sync");
  });
  await boss.createQueue(QUEUES.webhookReconcile, { retryLimit: 1, retryDelay: 600, expireInSeconds: 1800 });
  await boss.schedule(QUEUES.webhookReconcile, WEBHOOK_RECONCILE_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.webhookReconcile, async () => {
    if (await integrations.webhookClient()) await requestAllPublished(getDb(), new Date());
  });

  // A fresh library has document types and topic areas to draft with from the start.
  const addedTypes = await ensureDefaultDocumentTypes(getDb());
  if (addedTypes > 0) logger.info({ added: addedTypes }, "default document types added");
  const addedAreas = await ensureDefaultTopicAreas(getDb());
  if (addedAreas > 0) logger.info({ added: addedAreas }, "default topic areas added");

  // Uploads: text, screen, duplicate check, AI draft. Without an AI model
  // set up, uploads wait at the draft.
  const ocrConfig = getOcrConfig();
  const stopProcessor = startProcessor(
    {
      db: getDb(),
      storage: getStorage(),
      model: () => integrations.draftModel(),
      ocr: { command: ocrConfig.OCR_COMMAND, languages: ocrConfig.OCR_LANGUAGES },
      maxBytes,
      dailyDraftLimit: getAiLimitsConfig().AI_DAILY_LIMIT,
    },
    PROCESS_INTERVAL_MS,
  );

  // Messages to the Slack bot, stored by the web process; handled while a
  // bot token is set up.
  const stopSlackIntake = startPolling(
    "Slack intake",
    async () => {
      const slack = await integrations.slackIntakeClient();
      return slack ? processDueSlackEvents({ db: getDb(), storage: getStorage(), slack, maxBytes }) : {};
    },
    SLACK_INTAKE_INTERVAL_MS,
  );

  const stopDispatcher = startDispatcher({ db: getDb(), transports: () => integrations.transports(), intervalMs: DISPATCH_INTERVAL_MS });

  const stopHeartbeat = startHeartbeat({
    db: getDb(),
    workerId: hostname(),
    file: envValue("WORKER_HEARTBEAT_FILE") ?? DEFAULT_HEARTBEAT_FILE,
    channels: () => integrations.channels(),
  });
  logger.info(
    { directory: directory.kind, channels: await integrations.channels(), ocr: Boolean(ocrConfig.OCR_COMMAND) },
    "worker started",
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker stopping");
    stopHeartbeat();
    await stopProcessor();
    await stopSlackIntake();
    await stopDispatcher();
    await boss.stop({ graceful: true, timeout: 20_000 });
    await getPool().end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "worker failed to start");
  Sentry.captureException(error);
  await Sentry.flush(2_000);
  process.exit(1);
});
