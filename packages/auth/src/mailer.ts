/** Sends the sign in code. A host supplies one (Resend, Cloudflare Email). Without one the demo log line is used. */
export interface Mailer {
  send(email: string, code: string): Promise<void>;
}
