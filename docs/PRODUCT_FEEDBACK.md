# Product feedback

Feedback on every tool, API and SDK we used to build Hippo for the Build, Ship, Shape hackathon (Alexa+ track, October 2026). Each section answers the same five questions. Numbers are measurements from our own runs, and anything we did not run is marked as such. The matching friction entries are in `docs/FRICTION_LOG.md` (FL numbers).

---

## Alexa+ MCP add-on documentation and developer tools
- Used for: The design target of the whole project: a self hosted MCP server over Streamable HTTP with OAuth account linking, answered by voice and shown on a screen.
- Worked well: The QuickStart's shape is clear (Streamable HTTP, remote URL, 500 ms round trip, PKCE S256, protected resource metadata). We used it as the checklist for our own server, and our server follows it (bare 401, resource parameter, refresh tokens, `client_credentials` that cannot reach household data).
- Needs work: We could not use the CLI, the Local Inspector or the Web Simulator at all: access is by invitation and the setup pages never say so (FL-001). Two authentication pages disagree (FL-002), and the protocol version the client sends differs from the version the docs state (FL-003).
- Onboarding: Zero to hello world was not possible. We built an IAM user, an assume role policy and a profile exactly as the page says, and got AccessDenied. We then read the Devpost FAQ and built our own MCP client page instead.
- Would build with it again: Yes for the MCP server, no for the Alexa+ tooling until participants can reach it. The server we built is plain MCP and runs on any client.

## Model Context Protocol and `@modelcontextprotocol/sdk` 1.32.1
- Used for: The server (nine tools, three card button tools, stateless Streamable HTTP with JSON responses) and the client in our demo page and tests.
- Worked well: The web standard transport (`WebStandardStreamableHTTPServerTransport`) runs statelessly with `enableJsonResponse` and a parsed body, which fits Hono and Lambda. The real SDK `Client` over Streamable HTTP is our end to end test for every tool. Over a real socket, 50 sequential `tools/call` took p50 3.2 ms and p95 4.8 ms on a quiet run, and p50 16.8 ms and p95 31.9 ms on a loaded machine, against the 500 ms budget.
- Needs work: The web standard transport is hard to find (FL-012). `requireBearerAuth` always sets `WWW-Authenticate` (FL-011). ext-apps 1.x and 2.x pair with different SDK stacks and nothing says which (FL-010).
- Onboarding: About an hour from nothing to a working tool call, mostly reading the d.ts files for the transport.
- Would build with it again: Yes.

## MCP Apps (`@modelcontextprotocol/ext-apps` 1.7.x)
- Used for: Evaluated for the Coverage, Coming Up and Recall cards. We did not use the host bridge (decision D-054).
- Worked well: The design guidance (768 by 480 authoring, light and dark, text meaning for clients without cards) shaped our cards.
- Needs work: The host bridge needs a sandbox proxy iframe and `ui://` resources our server does not serve, and without the Alexa+ tooling there is no host to test it against. Version pairing is unclear (FL-010).
- Onboarding: Not completed. Our cards are plain React drawn from `structuredContent`, and the demo page says so.
- Would build with it again: Yes, with a host to test against.

## Hono 4.13.13 and `@hono/node-server` 2.1.5
- Used for: The HTTP layer for the MCP endpoint, the web JSON API and the OAuth server.
- Worked well: Small, typed, and `app.request()` makes every route testable without a socket. We have 669 API tests that run in memory.
- Needs work: `bodyLimit` trusts the `Content-Length` header (FL-013), and a mounted sub app does not inherit `notFound`.
- Onboarding: Minutes.
- Would build with it again: Yes.

## jose 6.2.12
- Used for: Signing and verifying access tokens (HS256, type `at+jwt`).
- Worked well: Strict algorithm pinning (`none` and HS384 are rejected in our tests), clear errors.
- Needs work: `jwtVerify` does not enforce `iat` (FL-013).
- Onboarding: Minutes.
- Would build with it again: Yes.

## MiniSearch 7.2.0
- Used for: In process clause search over a household's documents, so the voice path makes no model call.
- Worked well: With 2000 synthetic chunks, loading a serialized index took 21.6 ms median and one search 2.05 ms median on an idle run (60 to 107 ms and 5 to 10 ms under load). Serialization works.
- Needs work: Scores depend on corpus size (FL-018), and functions are not serialized, so the load options must match the build options.
- Onboarding: Minutes.
- Would build with it again: Yes.

## pdfjs-dist 6.4.299
- Used for: Text per page with stable page numbers, so every answer can cite the page.
- Worked well: Accurate text and page boundaries on all six demo documents.
- Needs work: The page count comes from the declared `/Count`, so a lying file silently loses pages (FL-015). It needs Node 22.13 or newer.
- Onboarding: An afternoon, mostly for the safety limits around hostile files.
- Would build with it again: Yes, with our own page count check.

## zod 4.6.7
- Used for: The five extraction schemas, every tool input and the web API inputs, all strict.
- Worked well: One schema serves model output validation, the review screen and tests. Every hand written fixture parses, and mutation checks on the household id rule fail as expected when a schema is loosened.
- Needs work: Nothing to report.
- Onboarding: Minutes.
- Would build with it again: Yes.

## Amazon DynamoDB and DynamoDB Local
- Used for: The single table repository (partition key per household, a sparse index for open alerts and upcoming obligations).
- Worked well: The same 271 case contract suite passes against our in memory repository and against DynamoDB Local, in two configurations (the compose file with `-sharedDb -inMemory` and the plain default image), and our CI now starts the image as a service container. Escaping the household id in the key means a hostile id cannot reach another household (tested).
- Needs work: DynamoDB Local reads indexes with strong consistency, so it cannot show the eventual consistency we rely on being careful about on real DynamoDB. We did not run against the real service.
- Onboarding: About an hour for the key design, minutes for DynamoDB Local with Docker.
- Would build with it again: Yes.

## AWS CDK (`aws-cdk-lib` 2.273.0)
- Used for: A stack for the table, the bucket, three Lambdas, a Function URL and the daily schedule. Synthesized and tested only; never deployed (decision D-037).
- Worked well: `Template.fromStack` assertions let us prove least privilege in tests (no wildcard actions except the documented ones) and that the Function URL gets both invoke permissions.
- Needs work: A dependency cycle between the Function URL and S3 CORS (FL-009), and there is no `bedrock:Converse` action to grant (FL-008).
- Onboarding: A few hours.
- Would build with it again: Yes.

## CPSC Recalls API
- Used for: Nightly recall checks for a household's products.
- Worked well: The records are rich once you have them, and a public API with no key made development easy.
- Needs work: A database failure is returned as a normal answer with a fake record, the UPC filter is unreliable, and an unknown parameter returns the whole database (FL-016).
- Onboarding: A day, mostly learning which behaviours cannot be trusted. Every failure path is tested with the real error body.
- Would build with it again: Yes, with the guards we wrote.

## NHTSA Recalls API
- Used for: Vehicle recalls by make, model and year.
- Worked well: Fast and consistent when the spelling is right.
- Needs work: A near miss returns zero results instead of an error, "no match" has two shapes, and dates are day first (FL-017).
- Onboarding: A few hours.
- Would build with it again: Yes.

## Amazon Bedrock (Converse API, Claude Haiku 4.5, Amazon Nova Lite)
- Used for: Designed as the model that reads uploaded documents into structured fields (`apps/workers/src/ingest/bedrock.ts`, Converse API, zod validation, one retry, a call cap, a 60 second timeout). Tested with fake clients only.
- Worked well: The model id, the `us.` inference profile and the IAM action are documented clearly: one action, `bedrock:InvokeModel`, covers Converse. `list-inference-profiles` showed the Nova profiles in seconds. We did not get to judge output quality.
- Needs work: We never got a model answer. First the call was denied for a Marketplace subscription while the availability API said "available" (FL-019). Then every call failed as throttling because every daily token quota on the account was 0.0 and not adjustable (FL-020), also for the Amazon owned Nova Lite. An AWS Support case was open at the deadline.
- Onboarding: Not achieved in about two hours of trying with a free plan account, one plan upgrade and one support case. We measured the quotas and the errors, not a model.
- Would build with it again: Yes for the design (the adapter is small), but only on an account that already has quota. A hackathon entrant on the free plan should expect to be blocked.

## Amazon Textract (`DetectDocumentText`)
- Used for: OCR for picture pages, as a fallback behind the pdf.js text layer. Tested with fakes in the repo.
- Worked well: Once the account could use it, one synchronous call read a 1 page JPEG (the warranty photo fixture) into 15 lines in a few seconds. This was one call through the AWS CLI, not through our adapter.
- Needs work: Before the plan upgrade it returned `SubscriptionRequiredException` with no hint about what to subscribe to (FL-021).
- Onboarding: Minutes once unblocked, an hour lost before.
- Would build with it again: Yes. We did not measure accuracy, cost or HEIC (not accepted by the sync API).

## Amazon SES (SESv2 `SendEmail`)
- Used for: The daily digest email (`apps/workers/src/daily/ses.ts`, three guards: `--send-ses`, `--yes-really`, a sender env variable, plus a 200 per day cap).
- Worked well: One real digest was sent on 2026-10-21 from a sandbox account to a verified address: `email: sent (10 alerts)` from `pnpm daily:run --send-ses --yes-really`. Verifying one address in the console took a click on the emailed link. It worked with an IAM user that may only call `ses:SendEmail` on that one identity.
- Needs work: The sandbox only delivers to verified recipients, so a live send needed a recipient override (`HIPPO_DIGEST_TO`). We did not check how the message looked in every mail client, did not measure delivery time or cost, and did not leave the sandbox.
- Onboarding: About ten minutes including the verification email.
- Would build with it again: Yes.

## AWS console, IAM and CloudShell
- Used for: Creating the least privilege user, policy and SES identity, and reading quotas.
- Worked well: CloudShell with the AWS CLI is the fast path (policy, user, quota listing in one terminal). Service Quotas can be listed read only from the CLI.
- Needs work: The IAM JSON policy editor did not accept pasted JSON (FL-022). Where the Free plan upgrade lives (the Free Tier page, not the account page) was hard to find.
- Would build with it again: Yes, with CloudShell first.

## The hackathon platform (Devpost) and rules
- Used for: Rules, the FAQ and the submission.
- Worked well: The FAQ is where the real answers are (partner only tools, a web page as MCP client counts, a local repo is enough).
- Needs work: The FAQ is found late, after the setup pages have sent entrants down a path that cannot work (FL-001). The credit codes ran out while the rules still describe the $150 credit (FL-005).
- Onboarding: Straightforward.
- Would take part again: Yes.

## Claude Code and parallel agents (development tooling)
- Used for: Building most of the code, with parallel agents in separate git worktrees and an independent read only reviewer.
- Worked well: The independent reviewer found real defects that our tests did not (two rounds on the backend: a masking bypass, a lost disclaimer, alerts left behind when a date changed, an unauthenticated body parse). Each fix was written test first.
- Needs work: Agents were interrupted twice by a session rate limit mid task (their work was saved and resumed). On a small machine, parallel test runs ran out of memory, so every package runs one at a time.
- Onboarding: Hours to a working setup.
- Would use it again: Yes.
