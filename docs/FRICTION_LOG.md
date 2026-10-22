# Friction log

Real entries only, written while building Hippo for the Build, Ship, Shape hackathon (Alexa+ track, October 2026). Each entry says whether we hit the problem while building (hit) or found it by reading documentation while designing (read). Dates are 2026. Severity: blocker (stopped the work), major (cost real time or forced a workaround in the design), minor (small, but worth fixing).

Source of truth for each entry: `MEMORY.md` gotchas (G-nnn). The G number is given so a reader can check the original note.

---

## Alexa+

### FL-001: The Alexa+ setup guide cannot be completed by a hackathon entrant, and nothing on the setup pages says so
- Area: Alexa+ developer tools (alexa-ai CLI, Local Inspector, Web Simulator), "Set Up Your Development Environment" page (hit; G-005, G-019, G-024)
- Task attempted: Install the `alexa-ai` CLI and the Local Inspector to test our MCP server the way the docs describe.
- Steps taken: Created an IAM user with an access key, attached the inline policy from the page that allows `sts:AssumeRole` on `arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`, configured an `alexa-ai` profile with that `role_arn`, and ran `aws sts get-caller-identity --profile alexa-ai`. Separately ran `npm view @alexa-ai/cli` and `npm view @alexa-ai/addon-local-inspector`.
- Expected: The role is assumed and the CLI installs from the CodeArtifact registry the page describes.
- Actual: `AccessDenied` on `sts:AssumeRole` even though the identity call with the same key worked. Both packages return E404 on public npm. The page also requires Node 24 or newer while our project guidance said Node 22. Only the Devpost FAQ says these tools are in preview and available to select partners only, with no way for participants to apply.
- Severity: blocker
- Workaround: Built our own web page that acts as a real MCP client (initialize, tools/list, tools/call over Streamable HTTP), which the FAQ confirms satisfies the track.
- Suggestion: Say at the top of every Alexa+ setup page that access is by invitation, and link the hackathon FAQ. A participant should find that in one minute, not after building the IAM user and profile.

### FL-002: Two Alexa+ authentication pages disagree
- Area: Alexa+ MCP authentication (read; G-003, G-018)
- Task attempted: Implement the authorization server so an Alexa+ client could link an account.
- Steps taken: Read the QuickStart page and the account linking page side by side.
- Expected: One checklist.
- Actual: The QuickStart says a 401 must carry no `WWW-Authenticate` header, which is the opposite of the generic MCP authorization spec. The account linking page adds requirements the QuickStart does not mention: a refresh token with every access token, protected resource metadata with specific required fields, and "return 401 or 403". The authorization server metadata section says `client_credentials` with scope `mcp:service` is needed "if you have a private MCP server" without saying whether that applies to a self hosted server.
- Severity: major
- Workaround: Built all of it (bare 401, refresh tokens with rotation, `client_credentials` that can never reach household data) and documented which parts we could not test against the real service.
- Suggestion: One page with one numbered checklist, and say which rules are mandatory for a self hosted server.

### FL-003: The Alexa+ client announces an older MCP protocol version than the docs say it supports
- Area: Alexa+ client lifecycle page versus toolkit overview (read; docs/VERIFIED.md 1.3)
- Task attempted: Decide which MCP protocol versions our server must accept.
- Expected: One stated version.
- Actual: The client lifecycle page shows the initialize request with protocol version `2025-03-26`. The overview page and the hackathon rules say `2025-11-25`.
- Severity: minor
- Workaround: The server negotiates down and accepts `2025-03-26` (tested with the real SDK client).
- Suggestion: State the version the client really sends, and which versions the platform will negotiate.

### FL-004: The documentation index URL in the hackathon material returns 404
- Area: Alexa+ docs (hit; docs/VERIFIED.md 1.1)
- Task attempted: Fetch `https://developer.amazon.com/docs/llms.txt` to find every Alexa+ page.
- Actual: HTTP 404, and the root `llms.txt` lists no Alexa+ URL.
- Severity: minor
- Workaround: Navigated by the sidebar links on the QuickStart page.
- Suggestion: Publish the index or drop the reference.

---

## AWS and the hackathon

### FL-005: The AWS credit codes ran out before many entrants started
- Area: Devpost Resources page, AWS promotional credits (hit; G-025)
- Task attempted: Plan the AWS Builder mini challenge on the $150 credit the rules describe.
- Actual: The Resources page says "October 7th Update: we are out of credit codes and are no longer accepting credit requests." The rules still describe the $150 credit.
- Severity: major
- Workaround: Fixture mode for every test; any live AWS call is one small call paid by an entrant, quoted and capped first.
- Suggestion: Update the rules text when credits end, or raise the pool. Entrants plan their AWS work from the rules.

### FL-006: Textract does not accept HEIC, the default format of a phone photo
- Area: Amazon Textract limits (read; G-020)
- Task attempted: Accept phone photos of paper documents.
- Actual: Accepted formats are JPEG, PNG, PDF and TIFF. Synchronous PDF and TIFF are limited to 1 page and 10 MB; larger or multi page needs the asynchronous path.
- Severity: major (for any consumer photo workflow)
- Workaround: Reject HEIC with a plain message telling the person to convert to JPEG; a multi page PDF with a picture page fails with a plain reason.
- Suggestion: Accept HEIC, or say in the quick start that phone photos need conversion first.

### FL-007: Bedrock structured output support differs per model and the newest models are listed as not supported
- Area: Amazon Bedrock Converse model cards (read; G-021)
- Task attempted: Choose a model for strict JSON extraction.
- Actual: On the model cards read on 2026-10-18, Converse structured output (`outputConfig.textFormat`) is listed as supported for Claude Haiku 4.5 and Sonnet 4.6, and listed as not supported for Haiku 5.5, Sonnet 5.5 and Nova 2 Lite. The JSON Schema subset has no `maxLength`, `minimum` or free `additionalProperties`. The page that used to hold the per model feature grid now shows an index.
- Severity: minor
- Workaround: Keep the 200 character quote cap in our own zod validation and our quote check; choose the model by the card, then test it.
- Suggestion: One current feature grid per model, and say when a feature is expected on the newest models.

### FL-008: There is no `bedrock:Converse` IAM action
- Area: Amazon Bedrock IAM (hit while writing the CDK stack; G-027)
- Task attempted: Write a least privilege policy for a Lambda that calls Converse.
- Actual: The Converse page states that calling Converse requires `bedrock:InvokeModel`. No `bedrock:Converse` action exists, although the API is called Converse.
- Severity: minor
- Workaround: Grant `bedrock:InvokeModel` only, scoped to the foundation model and inference profile.
- Suggestion: Put this sentence at the top of the Converse IAM section.

### FL-009: A Lambda Function URL needs two permissions, and CDK's S3 CORS cannot point at it
- Area: AWS Lambda Function URLs and CDK 2.273.0 (hit; G-022, G-026)
- Task attempted: Expose an MCP endpoint through a Function URL with CDK.
- Actual: Function URLs created from October 2025 need both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, or the endpoint returns 403. CDK `addFunctionUrl` with auth type NONE adds both (proved by a test on the synthesized template). Referencing the Function URL as an S3 CORS origin creates a dependency cycle, so the origin must be set after the first deploy and the stack redeployed. `addEventNotification` adds a helper Lambda with `PutBucketNotification` on `*`.
- Severity: minor
- Workaround: Context key for the web origin set after the first deploy; tests filter app functions by description.
- Suggestion: One sentence in the Function URL docs about the second permission, and a CDK note about the cycle.

---

## MCP SDK and web framework

### FL-010: MCP Apps and the MCP SDK have two incompatible version stacks
- Area: `@modelcontextprotocol/ext-apps` and `@modelcontextprotocol/sdk` (hit; G-016)
- Task attempted: Choose versions for the server and the cards.
- Actual: ext-apps 2.x peers on the split v2 server, client and core packages, not sdk 1.x. ext-apps 1.7.x pairs with sdk 1.x (latest sdk 1.32.1). Nothing in the packages says which pairs with which except the peer ranges.
- Severity: major
- Workaround: Pinned sdk 1.32.1 exactly and kept the cards as plain React from `structuredContent` (D-054), because the host bridge also needs a sandbox proxy and `ui://` resources our server does not serve.
- Suggestion: A compatibility table in the ext-apps README.

### FL-011: The SDK's bearer helper cannot be used for the Alexa+ rule
- Area: `@modelcontextprotocol/sdk` 1.32.1 `requireBearerAuth` (hit; G-017)
- Actual: The helper always sets `WWW-Authenticate` on a 401. The Alexa+ checklist forbids that header.
- Severity: major
- Workaround: Our own bearer check.
- Suggestion: Make the header optional.

### FL-012: The stateless web standard transport exists in 1.32.1 but is hard to find
- Area: `@modelcontextprotocol/sdk` 1.32.1 (hit; G-032)
- Actual: `WebStandardStreamableHTTPServerTransport` works statelessly with `enableJsonResponse` and a pre parsed body, which fits Hono and Lambda. It lives under a deep import path and is not mentioned in the quick start. A top level unknown key in a JSON-RPC message is a 400, and a discriminated union input lists as an object schema in `tools/list`.
- Severity: minor
- Suggestion: Document the web standard transport as the way to serve over fetch based frameworks.

### FL-013: Small library surprises in the auth and HTTP layer
- Area: jose 6.2.12, Hono 4.13.13 (hit; G-029, G-033, G-040)
- Actual: `jwtVerify` does not enforce `iat`, so a token issued in the future is accepted unless the caller checks. Hono `bodyLimit` trusts the `Content-Length` header, so a lying header passes it. A mounted Hono sub app's `notFound` handler is not inherited, so unknown paths under it fell through to the parent's 404. A `form-action` CSP blocks the post login redirect to the OAuth client.
- Severity: minor
- Workaround: Our own `iat` check, a second size check while reading, a catch all route, and no `form-action` on the login page.
- Suggestion: Document each in the library's security notes.

---

## Developer tooling

### FL-014: Four tooling snags on a current Node and TypeScript
- Area: typescript-eslint, corepack, jsdom, pnpm 12 (hit; G-023, G-042, G-043, G-035)
- Actual: typescript-eslint 8.71.2 declares peer `typescript >=4.8.4 <6.1.0`, so a TypeScript aware ESLint is not supported on TypeScript 7.0.2 (we ship with strict `tsc` instead). Corepack 0.31 on Node 22.14 downloaded pnpm 12.6.0 but could not run it (`Cannot find module .../pnpm.cjs`). jsdom 30 pulls undici 8, which crashes on Node 22.14 so vitest workers do not start. pnpm 12 rewrites `pnpm-workspace.yaml` during install to ask for a decision about build scripts.
- Severity: minor
- Workaround: strict `tsc` as the gate, `npm install -g pnpm@12.6.0`, jsdom 29.1.1 pinned, `allowBuilds` decided in the file.
- Suggestion: State the supported ranges and the Node floor in each project.

### FL-015: pdf.js trusts the page tree count, so a lying file silently loses pages
- Area: pdfjs-dist 6.4.299 (hit; G-015)
- Actual: `numPages` comes from the declared `/Count`, so a file that lies drops pages without an error. Its error messages can echo document text. It needs Node 22.13 or newer and wants its own copy of the byte buffer.
- Severity: major
- Workaround: Our own raw page object count cross check, fixed error messages, bounded decompression before pdf.js runs (D-031).
- Suggestion: Optional verification of the page count.

---

## Recall data (CPSC and NHTSA)

### FL-016: The CPSC recalls API reports a database failure as a normal answer
- Area: CPSC Recalls API (hit; G-012, G-013, G-002, G-001, G-008, G-009)
- Task attempted: Check a household's products against recalls every night.
- Actual: A database failure came back as HTTP 200 with one fake record (`RecallID` 0, `RecallNumber` null, title "Error retrieving Recalls: The underlying provider failed on Open."), observed on 2026-10-18 for every filtered query for a while. A client that reads it as an empty list gives a false all clear. The UPC filter returned an empty list for a UPC that exists in record 26530. An unknown parameter or an empty filter returns the whole database (10,053 records, no pagination). The default format is XML. One recall's title belongs to a different recall (26569). Child product recalls rarely carry a structured UPC or model (1 of 80 in our sample).
- Severity: major
- Workaround: Parse the fake record as an error, fetch by publish date window only, match UPCs client side, never use the title as evidence, and make every failure fail loudly (tested with the real error body).
- Suggestion: Return a 5xx or an error object on failure, and make the UPC filter work.

### FL-017: The NHTSA recalls API wants its own spellings and answers a near miss with zero results
- Area: NHTSA `recallsByVehicle` (hit; G-007, G-010, G-011, G-014)
- Actual: `model=CRV` returns `Count` 0 with HTTP 200 while the right spelling is `CR-V`. Elsewhere it returns HTTP 400 for a blank model or a non numeric year, so "no match" has two shapes. `ReportReceivedDate` is `DD/MM/YYYY`, not ISO. The models endpoint returns duplicate rows. Results are by make, model and year, not by VIN.
- Severity: major
- Workaround: Canonicalize through the models endpoint once, dedupe, say "may affect your car", never retry a 400.
- Suggestion: Return an error or suggestions for an unknown model, and one shape for no match.

---

## Search library

### FL-018: MiniSearch scores depend on the size of the corpus
- Area: MiniSearch 7.2.0 (hit; G-028)
- Actual: Scores are idf dependent and multiply with the number of matched terms, so a relevance threshold tuned on 17 chunks is conservative for a larger household. `processTerm` runs again on query strings, so pre stemmed terms must not be passed. `loadJS` needs the same options object as the build because functions are not serialized.
- Severity: minor
- Workaround: Threshold 2.25 chosen from the real fixture chunks (off topic queries match nothing), same options in build and load.
- Suggestion: Document the score scale.

---

## AWS (Bedrock, Textract, SES, IAM console)

### FL-019: Bedrock says a model is available, and the first call is then denied for a Marketplace subscription
- Area: Amazon Bedrock, Converse API with Claude Haiku 4.5 (hit; G-046)
- Task attempted: Make one real extraction call from a least privilege IAM user.
- Actual: `get-foundation-model-availability` reported the model `AUTHORIZED` and `AVAILABLE`, and the inference profile was `ACTIVE`. The first Converse call returned `AccessDeniedException` saying the user lacks `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe`. The subscription is created on first use by an identity that may subscribe. The same error also appeared in the console playground until the account was ready.
- Severity: major
- Workaround: Opened the model once in the Bedrock console playground as the account owner. A runtime user should not hold Marketplace permissions.
- Suggestion: Make the availability call say that a first use subscription is still pending, and name who can complete it.

### FL-020: Every Bedrock call fails with a throttling error because the account's daily token quotas are zero
- Area: Amazon Bedrock quotas, Service Quotas (hit; G-047, G-050)
- Task attempted: A 5 token test call to Claude Haiku 4.5 and to Amazon Nova Lite in us-east-1.
- Actual: `ThrottlingException: Too many tokens per day`, after two automatic retries, on every call. Service Quotas (read only) showed all 41 quotas with "tokens per day" in the name at 0.0, and every row that reports the flag showed `Adjustable: False`, so the console offered no increase button. The account was on the AWS Free plan. After the user upgraded to the paid plan and waited, the values were still 0.0 and the call still failed. An AWS Support case (account and billing, 179260044300224) was filed; no answer arrived before the deadline.
- Severity: blocker for the live Bedrock call (it was never made)
- Workaround: None found in time. The live extraction path was tested only against fake clients, and the docs say so.
- Suggestion: Say "this account has no quota" in the error instead of "throttling", show the quota and the plan restriction in the console next to the model, and tell free plan users what to do before they build on Bedrock.

### FL-021: Textract returns a subscription error that names no action, and it cleared after the plan upgrade
- Area: Amazon Textract `DetectDocumentText` (hit; G-048)
- Task attempted: OCR one JPEG page.
- Actual: `SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service`, with a valid IAM policy. After the account moved from the Free plan to the paid plan the same call succeeded: 1 page and 15 lines read from the dishwasher photo fixture (one call through the AWS CLI; the repo's own adapter was not run live because the model call that follows it was blocked).
- Severity: major
- Workaround: Upgrade the plan.
- Suggestion: Name the plan or the activation step in the message.

### FL-022: The IAM console JSON policy editor ignores text that is not typed key by key
- Area: AWS console, IAM "Create policy" JSON editor (hit; G-049)
- Task attempted: Create a three statement least privilege policy.
- Actual: Setting the editor text from outside, or inserting it as one paste, showed the JSON in the editor but the page still said "No actions specified" and Next stayed blocked. The same policy created at once with `aws iam create-policy` in CloudShell.
- Severity: minor
- Workaround: CloudShell, or the visual editor.
- Suggestion: Validate what the editor holds, not what was typed.
