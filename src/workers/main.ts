import { hostname } from "node:os";
import * as Sentry from "@sentry/node";
import { PgBoss } from "pg-boss";
import {
  getAiConfig,
  getDatabaseConfig,
  getDigestConfig,
  getEmailIntakeConfig,
  getErrorReportingConfig,
  getWebhookConfig,
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
import { createSlackIntakeClient } from "@/lib/slack/client";
import { createDraftModel } from "@/lib/library/draft";
import { startProcessor } from "@/lib/library/pipeline";
import { cleanUpOriginals } from "@/lib/library/originals";
import { recordReviewReminders } from "@/lib/library/review";
import { ensureDefaultDocumentTypes } from "@/lib/library/taxonomy";
import { createWebhookClient } from "@/lib/webhook/client";
import { requestAllPublished, syncDue } from "@/lib/webhook/sync";
import { logger } from "@/lib/logger";
import { retrySlackLookups, startDispatcher } from "@/lib/notifications/dispatch";
import { channelModes, createTransports } from "@/lib/notifications/transports";
import { getStorage } from "@/lib/storage";
import { DEFAULT_HEARTBEAT_FILE, startHeartbeat } from "./heartbeat";

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
    logger.error({ err: error }, "pg-boss error");
    Sentry.captureException(asError(error));
  });
  await boss.start();

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
  const notificationConfig = getNotificationConfig();
  const transports = createTransports(notificationConfig);
  const channels = channelModes(transports);
  await boss.createQueue(QUEUES.watch, { retryLimit: 1, retryDelay: 60, expireInSeconds: 600 });
  await boss.schedule(QUEUES.watch, WATCH_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.watch, async () => {
    await retrySlackLookups(getDb(), transports, new Date());
  });

  // Review reminders: a week after the draft to its owner, 30 days to the stewards.
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
    const deleted = await cleanUpOriginals(getDb(), getStorage());
    if (deleted > 0) logger.info({ deleted }, "originals deleted");
  });

  // The weekly digest, Mondays at 09:00: the library's channel and list, each
  // team's channel, and an email to everyone who follows tags.
  const digestConfig = getDigestConfig();
  await boss.createQueue(QUEUES.weeklyDigest, { retryLimit: 3, retryDelay: 300, expireInSeconds: 600 });
  await boss.schedule(QUEUES.weeklyDigest, WEEKLY_DIGEST_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.weeklyDigest, async () => {
    const now = new Date();
    const result = await recordWeeklyDigests(getDb(), now, { slackChannelId: digestConfig.DIGEST_SLACK_CHANNEL_ID, emailTo: digestConfig.DIGEST_EMAIL_TO });
    const personal = await recordPersonalDigests(getDb(), now);
    logger.info({ ...result, personal }, "weekly digest recorded");
  });

  // The intake mailbox, every 2 minutes.
  const emailIntake = getEmailIntakeConfig();
  const imapUrl = emailIntake.EMAIL_INTAKE_IMAP_URL;
  if (imapUrl) {
    const maxBytes = getUploadConfig().UPLOAD_MAX_MB * 1_048_576;
    const intakeDeps = { db: getDb(), storage: getStorage(), maxBytes, domains: emailIntake.EMAIL_INTAKE_DOMAINS };
    const open = () =>
      openImapMailbox({
        url: imapUrl,
        mailbox: emailIntake.EMAIL_INTAKE_MAILBOX,
        doneMailbox: emailIntake.EMAIL_INTAKE_DONE_MAILBOX,
        // Room for one file at the limit, base64-encoded, and the text around it.
        maxMessageBytes: Math.ceil(maxBytes * 1.4) + 1_048_576,
      });
    await boss.createQueue(QUEUES.emailIntake, { retryLimit: 0, expireInSeconds: 600 });
    await boss.schedule(QUEUES.emailIntake, EMAIL_INTAKE_CRON, {}, { tz: SERVER_TIME_ZONE });
    await boss.work(QUEUES.emailIntake, async () => {
      const counts = await pollMailbox(intakeDeps, open);
      if (Object.keys(counts).length > 0) logger.info(counts, "intake mailbox read");
    });
  } else {
    await boss.unschedule(QUEUES.emailIntake);
    if (await boss.getQueue(QUEUES.emailIntake)) await boss.deleteQueuedJobs(QUEUES.emailIntake);
  }

  // The webhook: changed notes every minute, everything compared nightly.
  const { WEBHOOK_URL, WEBHOOK_SECRET } = getWebhookConfig();
  if (WEBHOOK_URL && WEBHOOK_SECRET) {
    const syncDeps = {
      db: getDb(),
      client: createWebhookClient({ url: WEBHOOK_URL, secret: WEBHOOK_SECRET }),
      baseUrl: notificationConfig.LIBRARY_BASE_URL,
    };
    await boss.createQueue(QUEUES.webhookSync, { retryLimit: 0, expireInSeconds: 300 });
    await boss.schedule(QUEUES.webhookSync, WEBHOOK_SYNC_CRON, {}, { tz: SERVER_TIME_ZONE });
    await boss.work(QUEUES.webhookSync, async () => {
      const counts = await syncDue(syncDeps);
      if (Object.keys(counts).length > 0) logger.info(counts, "webhook sync");
    });
    await boss.createQueue(QUEUES.webhookReconcile, { retryLimit: 1, retryDelay: 600, expireInSeconds: 1800 });
    await boss.schedule(QUEUES.webhookReconcile, WEBHOOK_RECONCILE_CRON, {}, { tz: SERVER_TIME_ZONE });
    await boss.work(QUEUES.webhookReconcile, async () => {
      await requestAllPublished(getDb(), new Date());
    });
    channels.webhook = "live";
  } else {
    for (const queue of [QUEUES.webhookSync, QUEUES.webhookReconcile]) {
      await boss.unschedule(queue);
      if (await boss.getQueue(queue)) await boss.deleteQueuedJobs(queue);
    }
    channels.webhook = "off";
  }

  // A fresh library has document types to draft with from the start.
  const added = await ensureDefaultDocumentTypes(getDb());
  if (added > 0) logger.info({ added }, "default document types added");

  // Uploads: text, screen, duplicate check, AI draft.
  const aiConfig = getAiConfig();
  const ocrConfig = getOcrConfig();
  const stopProcessor = startProcessor(
    {
      db: getDb(),
      storage: getStorage(),
      model: createDraftModel(aiConfig),
      ocr: { command: ocrConfig.OCR_COMMAND, languages: ocrConfig.OCR_LANGUAGES },
      maxBytes: getUploadConfig().UPLOAD_MAX_MB * 1_048_576,
      dailyDraftLimit: aiConfig.AI_DAILY_LIMIT,
    },
    PROCESS_INTERVAL_MS,
  );

  // Messages to the Slack bot, stored by the web process.
  const slackToken = notificationConfig.SLACK_BOT_TOKEN;
  const slackIntake = slackToken
    ? { db: getDb(), storage: getStorage(), slack: createSlackIntakeClient(slackToken), maxBytes: getUploadConfig().UPLOAD_MAX_MB * 1_048_576 }
    : undefined;
  const stopSlackIntake = slackIntake ? startPolling("Slack intake", () => processDueSlackEvents(slackIntake), SLACK_INTAKE_INTERVAL_MS) : async () => {};

  const stopDispatcher = startDispatcher({ db: getDb(), transports, intervalMs: DISPATCH_INTERVAL_MS });

  const stopHeartbeat = startHeartbeat({
    db: getDb(),
    workerId: hostname(),
    file: envValue("WORKER_HEARTBEAT_FILE") ?? DEFAULT_HEARTBEAT_FILE,
    channels,
  });
  logger.info(
    { directory: directory.kind, channels, ai: aiConfig.AI_PROVIDER, ocr: Boolean(ocrConfig.OCR_COMMAND), slackIntake: Boolean(slackToken), emailIntake: Boolean(imapUrl) },
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
