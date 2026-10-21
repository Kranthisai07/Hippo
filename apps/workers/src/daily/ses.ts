// DAILY JOB ONLY. The Amazon SES send adapter for the digest email. The client, clock and sleep are injected, so nothing
// here touches the network by itself and the tests use a fake client. Nothing is logged. Errors carry only a class
// name or a fixed phrase: an SES message can hold the recipient address, and the subject and body are document text.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { UsageError } from "./options";
import type { Email, EmailSender } from "./types";

/** Anything with send(command): the real SESv2Client, or a fake in tests. */
export interface SesClientLike {
  send(command: SendEmailCommand): Promise<unknown>;
}

export interface SesSenderDeps {
  client: SesClientLike;
  /** A verified SES identity. */
  from: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Sandbox cap: 200 messages per 24 hours (docs/VERIFIED.md section 6). Default 200. Counted per process only: each daily run starts fresh. */
  maxPerDay?: number;
  /** Sandbox rate: 1 message per second. Default 1000. */
  minIntervalMs?: number;
}

const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;
const MAX_SUBJECT = 200;
// One plain address: no quotes, angle brackets, commas, spaces or non-ASCII, so no display name and no second address.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

export const isEmailAddress = (s: string): boolean => s.length <= 254 && EMAIL.test(s);

/** An error whose message is its name: safe to print and to keep. */
function fixed(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** SDK error class names are plain identifiers. Anything else (an odd throw) becomes a fixed phrase. */
function safeName(e: unknown): string {
  const n = e instanceof Error ? e.name : "";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(n) && n !== "Error" ? n : "SesError";
}

// Error names from SendEmailCommand's declared throws (client-sesv2 3.1152.0): TooManyRequestsException is the throttle.
// ThrottlingException and InternalServiceErrorException are not declared for this command but are the SDK's generic and
// service names for the same conditions. Every other declared error (MessageRejected, BadRequestException,
// NotFoundException, SendingPausedException, AccountSuspendedException, LimitExceededException,
// MailFromDomainNotVerifiedException) is permanent. Unverified against a live account; a retry after a 5xx can duplicate an email if the first request landed.
const RETRYABLE = new Set(["TooManyRequestsException", "ThrottlingException", "InternalServiceErrorException"]);
function retryable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (RETRYABLE.has(e.name)) return true;
  const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

export function createSesSender(deps: SesSenderDeps): EmailSender {
  const maxPerDay = deps.maxPerDay ?? 200;
  const interval = deps.minIntervalMs ?? 1000;
  if (!isEmailAddress(deps.from)) throw fixed("SesInvalidFrom");
  let last: number | null = null;
  let sentAt: number[] = [];

  /** Reserve a slot synchronously (like the NHTSA client) so concurrent calls queue instead of racing. */
  async function reserve(): Promise<void> {
    const now = deps.now();
    sentAt = sentAt.filter((t) => t > now - DAY_MS);
    if (sentAt.length >= maxPerDay) throw fixed("SesDailyCapExceeded");
    const slot = last === null ? now : Math.max(now, last + interval);
    last = slot;
    sentAt.push(slot);
    if (slot > now) await deps.sleep(slot - now);
  }

  return {
    async send(email: Email): Promise<void> {
      const { to, subject, text, html } = email;
      if (!isEmailAddress(to)) throw fixed("SesInvalidRecipient");
      if (subject.length === 0 || subject.length > MAX_SUBJECT || CONTROL.test(subject))
        throw fixed("SesInvalidSubject");
      if (text.trim() === "" || html.trim() === "") throw fixed("SesEmptyBody");
      const command = new SendEmailCommand({
        FromEmailAddress: deps.from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
          },
        },
      });
      for (let attempt = 1; ; attempt++) {
        await reserve();
        try {
          await deps.client.send(command);
          return;
        } catch (e) {
          if (attempt >= MAX_ATTEMPTS || !retryable(e)) throw fixed(safeName(e));
          await deps.sleep(BACKOFF_MS * 2 ** (attempt - 1));
        }
      }
    },
  };
}

export interface ResolveSesDeps {
  sendSes: boolean;
  yesReally: boolean;
  /** The console-only --send flag. Mixing it with --send-ses is refused so there is one clear destination. */
  send: boolean;
  env: Record<string, string | undefined>;
  /** Builds the real SESv2Client. Called only after every guard has passed. */
  makeClient: (region: string) => SesClientLike;
  warn: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The CLI guard: a real client exists only with --send-ses, --yes-really, HIPPO_SES_FROM and a region. */
export function resolveSesSender(d: ResolveSesDeps): EmailSender | undefined {
  if (!d.sendSes) return undefined;
  if (d.send) throw new UsageError("Use either --send (console only) or --send-ses, not both.");
  const from = d.env.HIPPO_SES_FROM;
  const region = d.env.HIPPO_SES_REGION || d.env.AWS_REGION;
  if (!from || !isEmailAddress(from))
    throw new UsageError("--send-ses needs HIPPO_SES_FROM set to one verified SES address.");
  if (!region || !/^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(region))
    throw new UsageError("--send-ses needs HIPPO_SES_REGION or AWS_REGION set to a region such as us-east-1.");
  d.warn(
    "WARNING: this sends real email through SES and may cost money; sandbox accounts can only send to verified addresses.",
  );
  if (!d.yesReally) throw new UsageError("Refusing to send: add --yes-really to confirm a live SES send.");
  return createSesSender({ client: d.makeClient(region), from, sleep: d.sleep, now: d.now });
}
