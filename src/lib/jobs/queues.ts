/** pg-boss queues and schedules. pg-boss keeps its tables in the `pgboss` schema. */
export const QUEUES = {
  directorySync: "directory-sync",
  watch: "watch",
  webhookSync: "webhook-sync",
  webhookReconcile: "webhook-reconcile",
  reviewReminders: "review-reminders",
  storageCleanup: "storage-cleanup",
  weeklyDigest: "weekly-digest",
  emailIntake: "email-intake",
} as const;

/** Originals of deleted notes that storage did not delete at once, every 10 minutes. */
export const STORAGE_CLEANUP_CRON = "*/10 * * * *";

/** Changed notes go to the webhook every minute. */
export const WEBHOOK_SYNC_CRON = "* * * * *";

/** Every published note is compared with what the webhook received, at 02:30. */
export const WEBHOOK_RECONCILE_CRON = "30 2 * * *";

/** Review reminders at 09:00, Monday to Friday. */
export const REVIEW_REMINDERS_CRON = "0 9 * * 1-5";

/** The weekly digest, Mondays at 09:00. */
export const WEEKLY_DIGEST_CRON = "0 9 * * 1";

/** The intake mailbox, every 2 minutes. */
export const EMAIL_INTAKE_CRON = "*/2 * * * *";

/** Directory sync every 15 minutes (Keycloak directory). */
export const DIRECTORY_SYNC_CRON = "*/15 * * * *";

/** Slack lookups that failed a week ago, every 30 minutes. */
export const WATCH_CRON = "*/30 * * * *";

/** How often the worker looks for notifications to send. */
export const DISPATCH_INTERVAL_MS = 5_000;

/** How often the worker looks for messages to the Slack bot. */
export const SLACK_INTAKE_INTERVAL_MS = 5_000;

/** How often the worker looks for uploads to process. */
export const PROCESS_INTERVAL_MS = 10_000;
