import { parseArgs } from "node:util";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { createMemoryRepository } from "core/src/repository";
import { DEMO_HOUSEHOLD, seedDemoHousehold } from "./demo";
import { recordedFetch } from "./recorded";
import { parseToday, UsageError, wholeNumber } from "./options";
import { runDaily } from "./runDaily";
import { formatReport } from "./format";
import { resolveSesSender } from "./ses";
import type { EmailSender } from "./types";

// Composition root: the only file allowed to read the real clock, the network and the console.
// --send uses a console sender that only prints. The real SES sender needs --send-ses AND --yes-really AND HIPPO_SES_FROM
// AND a region; the SESv2Client is constructed only then, so a default run never touches AWS.
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      today: { type: "string" },
      send: { type: "boolean", default: false },
      "send-ses": { type: "boolean", default: false },
      "yes-really": { type: "boolean", default: false },
      "live-recalls": { type: "boolean", default: false },
      "lookback-days": { type: "string" },
      "max-nhtsa": { type: "string" },
      "app-url": { type: "string", default: "http://localhost:5173" },
    },
  });
  const today = parseToday(values.today, new Date().toISOString().slice(0, 10));
  const lookbackDays = wholeNumber("lookback-days", values["lookback-days"], 1, 365);
  const maxNhtsa = wholeNumber("max-nhtsa", values["max-nhtsa"], 1, 100);

  const repository = createMemoryRepository();
  await seedDemoHousehold(repository, today, DEMO_HOUSEHOLD, process.env.HIPPO_DIGEST_TO?.trim() || undefined);

  const live = values["live-recalls"] === true;
  const sesSender = resolveSesSender({
    sendSes: values["send-ses"] === true,
    yesReally: values["yes-really"] === true,
    send: values.send === true,
    env: process.env,
    // maxAttempts 1: the SDK retries by default, and the sender does its own bounded retries.
    makeClient: (region) => new SESv2Client({ region, maxAttempts: 1 }),
    warn: (line) => console.error(line),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const sender: EmailSender | undefined =
    sesSender ??
    (values.send ? { send: async (e) => void console.log(`[console sender] to ${e.to}: ${e.subject}`) } : undefined);
  const report = await runDaily(
    {
      repository,
      // A memory repository has no way to list households, so the CLI lists the one it seeded.
      listHouseholdIds: async () => [DEMO_HOUSEHOLD],
      fetch: live ? async (url) => fetch(url, { signal: AbortSignal.timeout(15_000) }) : recordedFetch(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      sender,
      now: () => Date.now(),
      appUrl: values["app-url"] as string,
      config: {
        ...(lookbackDays !== undefined ? { lookbackDays } : {}),
        ...(maxNhtsa !== undefined ? { maxNhtsaRequests: maxNhtsa } : {}),
      },
    },
    today,
  );
  console.log(
    `recalls: ${live ? "LIVE CPSC and NHTSA" : "recorded fixtures"}; email: ${sesSender ? "LIVE SES" : sender ? "console sender" : "dry run"}`,
  );
  console.log(formatReport(report));
}

main().catch((e) => {
  // A usage mistake gets its message; anything else prints only its name, because a message could hold document text.
  console.error(
    e instanceof UsageError ? e.message : `daily job failed: ${e instanceof Error ? e.name : "unknown error"}`,
  );
  process.exitCode = 1;
});
