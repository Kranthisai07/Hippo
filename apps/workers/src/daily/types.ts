import type { Repository } from "core/src/contracts";
import type { FetchLike } from "obligation-kit/src/recalls/clients";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(email: Email): Promise<void>;
}

export interface DailyConfig {
  /** CPSC window: LastPublishDateStart is today minus this many days. Default 90. */
  lookbackDays?: number;
  /** Cost guard: most NHTSA requests per run, retries included. Default 20. */
  maxNhtsaRequests?: number;
  /** Most items in one digest. Default 10. */
  digestMaxItems?: number;
}

export interface DailyDeps {
  repository: Repository;
  /**
   * The Repository has no list-households method, so the job asks for ids separately. A DynamoDB implementation needs
   * a way to enumerate household records (a scan of the household META items, or a GSI on a constant partition), see
   * the T3.4 report.
   */
  listHouseholdIds(): Promise<string[]>;
  /** Used for CPSC and NHTSA only. */
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  /** Absent means a dry run: the digest is built and reported, nothing is sent and nothing is marked emailed. */
  sender?: EmailSender;
  /** Epoch milliseconds. The only clock the job reads. */
  now: () => number;
  /** Link in the digest. Must satisfy the digest builder's URL rules. */
  appUrl: string;
  config?: DailyConfig;
}

/** A failure that is safe to print: a fixed source, a kind, and the client's own message (never a URL, body or token). */
export interface RunError {
  source: "cpsc" | "nhtsa" | "obligations" | "digest" | "household";
  kind: "api_error" | "request_cap" | "no_canonical_vehicle" | "unexpected";
  message: string;
  assetId?: string;
}

export type EmailOutcome =
  | {
      status: "sent";
      alertIds: string[];
      /** The mail went out but recording it failed, so these alerts will be mailed again. */ markFailed?: boolean;
    }
  | {
      status: "skipped";
      reason: "digest_off" | "no_email" | "nothing_to_send" | "dry_run";
      preview?: { subject: string; text: string; alertIds: string[] };
    }
  | { status: "failed"; reason: string; alertIds: string[] };

export interface HouseholdReport {
  householdId: string;
  obligationsComputed: number;
  alertsCreated: number;
  alertsRefreshed: number;
  alertsLeftAlone: number;
  alertsDismissed: number;
  /** CPSC records examined against this household's assets, plus NHTSA recalls returned for its vehicles. */
  recallsChecked: number;
  recallAlertsCreated: number;
  errors: RunError[];
  email: EmailOutcome;
}

export interface RunReport {
  today: string;
  households: HouseholdReport[];
  requests: { cpsc: number; nhtsa: number; nhtsaCap: number; nhtsaCapReached: boolean };
}
