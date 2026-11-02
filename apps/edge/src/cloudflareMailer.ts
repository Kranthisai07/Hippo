import type { Mailer } from "@hippo/auth";

// The sign in mail through the Cloudflare Email Sending binding: `[[send_email]]` with `name = "EMAIL"`, and
// `env.EMAIL.send({ from, to, subject, text })`, which returns `{ messageId }` and throws an Error with a `code` such as
// E_SENDER_NOT_VERIFIED (docs/VERIFIED.md 10.15). The service is in beta and on the paid plan, `from` must be on a verified
// domain, and none of that can be tried without an account, so it is only checked here against a fake binding.

/** The part of the email binding used here. */
export interface EmailBindingLike {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}

export function createCloudflareMailer(binding: EmailBindingLike, from: string): Mailer {
  return {
    async send(email, code) {
      // Plain text only. The code is the one secret in this message, and it is never logged, here or by the caller.
      await binding.send({
        from,
        to: email,
        subject: "Your Hippo sign in code",
        text: `Your Hippo sign in code is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, you can ignore this email.`,
      });
    },
  };
}
