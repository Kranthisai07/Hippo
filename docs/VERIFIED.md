# VERIFIED.md: live documentation versus the project spec

Checked on 2026-10-18 (T0.2). Every claim below carries its URL. Verdict values: MATCHES SPEC, DIFFERS FROM SPEC, UNVERIFIED.

Method notes:
- Pages were read with WebFetch, which summarizes with a small model. Where a fact is load-bearing, a second read, a package inspection or a live request backs it. Where only a summary exists, the item says so.
- npm facts come from `npm view` and from installed package types on 2026-10-18.
- No AWS call, Bedrock call, Textract call or Alexa+ deploy was made. Everything about those services is documentation only.
- Raw HTTP responses for CPSC and NHTSA were saved in the session scratch directory, not in the repo, because T0.2 may write only this file.

---

## 1. Alexa+ MCP add-on

Base: https://developer.amazon.com/docs/alexaplus/add-ons/ (all pages below read 2026-10-18).

### 1.1 Docs index (`llms.txt`)
- https://developer.amazon.com/docs/llms.txt returned HTTP 404. https://developer.amazon.com/llms.txt did not list any alexaplus URL.
- Verdict: DIFFERS FROM SPEC (SPEC section 15 lists the first URL as the docs index; it does not exist today).
- Means for us: navigate by the sidebar links on the QuickStart page, not by the index. The page list used here is in 1.12.

### 1.2 QuickStart (`mcp-toolkit-quickstart`)
- Transport must be Streamable HTTP. Legacy HTTP+SSE is called deprecated. Server needs a remote URL (tunnel such as cloudflared is allowed for dev). Query round trip "less than 500 ms". Visuals follow MCP Apps via `@modelcontextprotocol/ext-apps`.
- Verdict: MATCHES SPEC.
- Alexa+ refreshes tool information only on deployment; after any change to tools or config run `alexa-ai deploy` again.
- Verdict: not in SPEC. Means for us: the demo checklist needs a redeploy step after every tool description change.

### 1.3 Client lifecycle (`mcp-toolkit-client-lifecycle`)
- Initialize request from the Alexa+ client: protocol version `2025-03-26`, client name "Alexa+ MCP Client", declares `roots` with `listChanged: true`.
- The toolkit overview page (`mcp-toolkit-overview`) says Alexa+ supports the `2025-11-25` MCP spec.
- Verdict: DIFFERS FROM SPEC in a small way (SPEC and Devpost say 2025-11-25). The two Amazon pages disagree with each other. Means for us: the server must negotiate down. The v1 SDK lists 2025-06-18, 2025-03-26 and older as supported, so negotiation works. Do not reject a 2025-03-26 initialize.
- Elicitation: the page says Alexa+ "uses the existing elicitation framework through the MCP protocol" when details are missing. No payload format is shown. UNVERIFIED whether our server may send elicitation requests; stateless JSON mode cannot send server-initiated requests mid-call anyway. Means for us: do not rely on elicitation. Ask a short spoken question in the tool result instead (SPEC section 6 already does this).
- UI resources: Alexa+ renders a visual when the tool result carries `_meta.ui` with `resourceUri` (example `ui://hotel-search`), plus `invoking` and `invoked` strings. With no `resourceUri` it uses a "data-only flow".
- Verdict: MATCHES SPEC. Note `invoking` and `invoked` are not in SPEC.
- Notifications: only the `roots` capability flag is mentioned. UNVERIFIED for any other notification.
- File uploads: no upload mechanism described ("files must be referenced by designated paths"). UNVERIFIED; matches decision D-003 (upload through the web app).
- Timeouts and size limits: not mentioned on this page.

### 1.4 Authentication: two pages that need reconciling
Page A, QuickStart (https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart):
- Return `401 Unauthorized` for unauthenticated requests "without a `WWW-Authenticate` header".
- Host Protected Resource Metadata per RFC 9728.
- Serve AS metadata at `/.well-known/oauth-authorization-server`; `code_challenge_methods_supported` must include `S256` or account linking will not proceed.
- OAuth 2.1 authorization code with PKCE S256; `resource` on authorize and token requests; Bearer token in the `Authorization` header only, never the query string.
- Not supported: DCR, Client ID Metadata Documents, OIDC, Step-Up Authorization, `WWW-Authenticate` in 401 responses.
- Verdict: MATCHES SPEC section 1 and section 12 on every line.

Page B, account linking (https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking):
- Account linking is optional ("only if tools need user identity"). We need it.
- Only the authorization code grant. Static client registration required.
- PRM at `https://<server>/.well-known/oauth-protected-resource` with required fields `resource`, `authorization_servers`, `scopes_supported`. `resource` must match the manifest URL (trailing slash may be present or absent). Alexa uses only the first entry of `authorization_servers`.
- Alexa reads the metadata at `configure-account-linking` and deploy time, caches it, and blocks deployment if PKCE S256 is missing. Redeploy after any AS change.
- Return 401 or 403 when a tool is called without a valid token; Alexa then starts linking. Alexa re-links on expiry or revocation.
- Authorization request params: `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, `resource`. Token request: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `resource`. `resource` is not sent on refresh.
- Redirect URIs: register all Alexa redirect URIs from the Alexa+ Developer Hub; at runtime validate the exact `redirect_uri` Alexa sends against the registered list. Do not hardcode one.
- "Your token endpoint must return a refresh token alongside every access token." Without it customers must re-link at each expiry.
- Client secret is optional in the setup guidance; if used, pass it through `ALEXA_CLIENT_SECRET` or the masked prompt, never a plain flag.
- Needs a public privacy policy covering account data.
- Verdict: MOSTLY MATCHES SPEC. DIFFERS FROM SPEC on three points: refresh tokens are required (SPEC section 12 does not mention them); the PRM path and required fields are specific; the 401 page says "401 or 403" (QuickStart says 401).

Page C, authentication (https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication):
- Describes a two-tier model. Tier 1 is service-level `client_credentials` with scope `mcp:service`, used for things like initialize, tools/list and health checks. The page's table labels it "if you have a private MCP Server", so it may be conditional; the same page also says the AS metadata "must include" it, so adding it is cheap and safe. Tier 2 is user-level authorization code plus PKCE.
- AS metadata `grant_types_supported` "must include" `client_credentials`. Token endpoint authenticates via HTTP Basic or POST body, validates `resource`, issues only `mcp:service`, issues no refresh token for client credentials, and an `expires_in` of 3600 seconds or fewer is recommended (the page says "Issue a short-lived access token (3600 seconds or fewer recommended)"; no "pre-certification" wording was found on that page).
- Scopes named: `mcp:service`, `mcp:tools`, `mcp:resources`.
- Service tokens must not grant access to user-specific data.
- Verdict: DIFFERS FROM SPEC. SPEC section 12 has one pre-registered Alexa client using the authorization code only. Page C implies Alexa also calls our token endpoint with `client_credentials` before any user links. UNVERIFIED whether Tier 1 is mandatory for an add-on that has only user-level tools. Means for us: build the `client_credentials` grant on the token endpoint now (small), return a token that works for `initialize` and `tools/list` only, and test with the real service before the demo. Tool handlers must return 401 for a service token on user-scoped tools.

401 and the SDK: the v1 SDK `requireBearerAuth` middleware always sets a `WWW-Authenticate` header (checked in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/middleware/bearerAuth.js`, lines 56 to 72). That is the opposite of the Alexa rule. Means for us: write our own bearer check that returns a bare 401 JSON body; do not use the SDK middleware as is.

### 1.5 Response size and latency
- Latency: 500 ms round trip (QuickStart). Functional requirements page (https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements) adds a best-practice "return results within 3 seconds" with an interim message for slow calls, and "keep voice responses under 30 seconds".
- Response size limit: not found on QuickStart, client lifecycle, functional requirements, API reference, design guide or layout pages. UNVERIFIED.
- Layout page: no numeric size limit for UI HTML; guidance is one self-contained file, gzip the response.
- Verdict: latency MATCHES SPEC; size UNVERIFIED. Means for us: keep tool results small anyway (SPEC section 6 already caps spoken text at 45 words).

### 1.6 Functional requirements that touch our tools
Same functional requirements page: every tool in `tools/list` must be invocable; a valid JSON Schema `inputSchema` with required fields declared; validate input against the schema; return stable IDs for multi-step flows; include synonyms in parameter descriptions; no API codes, tool names, JSON or internal IDs in customer-facing text; use `isError: true` or JSON-RPC errors for failures; max 5 spoken options.
- Verdict: MATCHES SPEC section 6 (response contract). Add: synonyms in parameter descriptions.

### 1.7 CLI install (`alexa-ai`)
Source: https://developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment
- Package `@alexa-ai/cli`, `npm install -g @alexa-ai/cli`. The `@alexa-ai` scope is served from a PRIVATE AWS CodeArtifact registry (domain `alexa-ai`, repository `npm-packages`, region `us-west-2`).
- Access needs an IAM user plus an `alexa-ai` AWS profile that assumes role `AddOn3PDeveloperToolsRead` in account 372468808636, "the AWS account you gave the Alexa Solutions Architect". Git credential helper for CodeCommit is needed so `alexa-ai new action` can clone templates.
- Node.js 24 or higher. macOS Sierra or later, or Ubuntu (Windows is not listed for the CLI).
- Check: `npm view @alexa-ai/cli` and `npm view @alexa-ai/addon-local-inspector` on public npm both returned E404 on 2026-10-18.
- Verdict: DIFFERS FROM SPEC (SPEC says "if CLI access"). The CLI is not publicly installable. Means for us: D-ALEXA depends on whether K or P has the Solutions Architect AWS account grant. The page does not say how to get approved. UNVERIFIED: whether hackathon entrants get this access automatically. Dev machines need Node 24 for the CLI, while CLAUDE.md and SPEC say Node 22 (Lambda supports both, see 5.4).

### 1.8 CLI commands
Source: https://developer.amazon.com/docs/alexaplus/add-ons/alexa-ai-cli-reference
- `configure` (LWA browser login, `--no-browser` for headless, credentials in `~/.alexa-ai/credentials`), `new mcp --name --locale --mcp-server-url`, `deploy` (skips upload if the package hash is unchanged unless `--ignore-hash`), `test`, `submit`, `list`, `status`, `configure-account-linking --addon-id --config-file`, `get-account-linking`.
- The QuickStart example uses `configure-account-linking --addon-id <id> --stage development --client-id <id>`, while the CLI reference lists `--config-file` as required. The two pages disagree. UNVERIFIED which is current.
- Verdict: not in SPEC. Means for us: write the exact commands into a README section only after running them.

### 1.9 Add-on manifest
Source: QuickStart, `addon-package/addon.json`.
- `manifestVersion` "1.0"; `storeListing.distributionCountries`; `locales.en-US` with `name.value` (max 30 chars), `shortDescription` (max 123), `fullDescription` (max 4000), `examplePhrases` (3 to 4, each max 200), `privacyAndCompliance.privacyPolicyUrl` and `termsOfUseUrl` (valid HTTPS URLs), icons in six sizes (72, 64, 88, 126, 180, 241 square, PNG/JPG/JPEG/WEBP over HTTPS), at least one 600x900 carousel image with alt text up to 250 chars, optional 1200x600 banner; `integrations[]` with `type: "MCP"`, `config.endpoints.default.type: "HTTPS"`, `uri`.
- Verdict: MATCHES SPEC (privacy and terms URLs). Adds: six icon sizes and a carousel image are required, so T-tasks need art assets. Privacy policy must also cover account data (account-linking page).

### 1.10 Local Inspector and testing
Sources: https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-local-inspector and https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-test-add-ons
- Needs Node 24+, `@alexa-ai/addon-local-inspector` (private registry, same as the CLI; E404 on public npm), and optionally `@playwright/cli` for visual analysis. The page does not give the install command for the inspector; it points to the Developer Console Getting Started guide.
- Run: `addon-local-inspector https://your-mcp-server.example.com/mcp` (defaults: proxy port 6277, UI port 6274; flags `--server-port`, `--client-port`, `--verbose`). The endpoint can be `http://` so a local server works.
- Renders widgets in Alexa device frames at two breakpoints (small is 10 inch and below, large is 11 inch and above) and checks the data layer (tool definitions, payloads, errors, latency). Outputs `certification-verdict.json` and `inspection-summary.json` with verdicts CERTIFIED, CONDITIONAL or NOT_CERTIFIED, in the temp directory.
- Only tools with a `ui://` URI in `_meta.ui.resourceUri` render visually. Run `resources/read` before the first `tools/call` or the widget stays blank.
- Test page: deploy first; then MCP Inspector for schemas, Local Inspector, web simulator, physical device. Access and allowlist rules for the simulator and devices: UNVERIFIED (not on the page).
- Verdict: not in SPEC (SPEC has `pnpm inspect` as "MCP Inspector"). Means for us: `pnpm inspect` can use the generic MCP Inspector from public npm; the Alexa Local Inspector only if we get registry access.

### 1.11 MCP Apps design guide and layout rules
Sources: https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-layout-and-rendering, `mcp-addon-visual-foundations`, `mcp-addon-display-modes`, `mcp-addon-design-guide`.
- Base design canvas 768x480; Echo Show 8/15 renders at 1280x800 (scale 1.667, apply one root scale such as `zoom: 1.667`). The layout page itself gives no canvas size and says not to design for specific device sizes; the visual foundations page gives 768x480. Verdict: MATCHES SPEC, with the caveat that the two pages differ in tone.
- Light and dark: "Dark mode is required" (visual foundations). Theme comes from `hostContext.theme`; `deviceClass` is authoritative, `maxWidth` and `displayMode` are fallback. Re-resolve on `host-context-changed`. Verdict: MATCHES SPEC.
- Type scale (px): display 48/40/32/28/24, headline 20/18, body 16/14/12, label 10/8. Spacing 2, 6, 8, 12, 16, 20, 24. Radius 4, 8, 12, 16. Dark card `#14181E`, light card `#FFFFFF`.
- CSP: declared in `_meta.ui.csp` with `connectDomains` and `resourceDomains`; undeclared destinations are blocked. The `ext-apps` types say `csp` belongs on the UI resource, not the tool (see 2.6). Verdict: MATCHES SPEC; place it on the resource.
- `ui://` URIs: example `ui://.../widget-a3f9c12b.html` with a content hash. MIME type is not stated on the Alexa page; the ext-apps constant is `text/html;profile=mcp-app` (2.6). Verdict: MATCHES SPEC.
- Sandbox: opaque-origin document; no `window.parent`, no `localStorage` or cookies; talk only through the postMessage bridge (`ui/notifications/*`).
- Viewports: Block (scrolls horizontally, recommended for native Alexa+) and Card (scrolls vertically). Display modes: inline (default), fullscreen, hydrated (data without UI; contact the Solutions Architect), voice-only. Touch target minimum is mentioned but the value is not on these pages.
- Verdict: size, touch-target value and button rules UNVERIFIED (Accessibility and Components pages not read).

### 1.12 Pages read
mcp-toolkit-quickstart, mcp-toolkit-client-lifecycle, mcp-toolkit-overview, mcp-toolkit-authentication, mcp-toolkit-account-linking, mcp-toolkit-local-inspector, mcp-toolkit-test-add-ons, mcp-toolkit-supported-capabilities (only auth and account linking listed, no capability matrix), set-up-your-development-environment, alexa-ai-cli-reference, alexa-plus-addon-api-reference (REST, no MCP limits), certification-guidelines (index only), functional-requirements, overview (no eligibility info), mcp-addon-design-guide and its layout, visual foundations and display-modes sub-pages. Not read: accessibility, components-and-patterns, conversation-surface, brand-expression, store-listing, policy-requirements, certify.

---

## 2. MCP spec, SDK and ext-apps

### 2.1 Streamable HTTP, spec 2025-11-25
Source: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- One MCP endpoint path supporting POST and GET. Client POSTs one JSON-RPC message per request with `Accept` listing both `application/json` and `text/event-stream`. For a JSON-RPC request the server returns either `text/event-stream` or a single `application/json`. For a notification or response the server returns 202 with no body.
- GET may return 405 if the server offers no SSE stream. Sessions are optional: a server "MAY" assign `MCP-Session-Id`. `MCP-Protocol-Version` header on later requests. Server "MUST validate the Origin header" and return 403 on an invalid one.
- Verdict: MATCHES SPEC ("stateless, JSON responses" is allowed by the spec). Means for us: `/mcp` must answer GET with 405, and validate `Origin` when present (Alexa is not a browser, so it should send none; browsers must not reach it).

### 2.2 npm packages (npm view, 2026-10-18)
| Package | Latest | Notes |
| :--- | :--- | :--- |
| `@modelcontextprotocol/sdk` | 1.32.1 (modified 2026-10-05), MIT, node >=18 | peers `zod ^3.25 or ^4.0`, `@cfworker/json-schema ^4.1.1`. dist-tag latest is 1.x |
| `@modelcontextprotocol/ext-apps` | 2.0.3 (modified 2026-09-28), MIT, node >=20 | 2.x peers: `zod ^4.2.0`, react, `@modelcontextprotocol/core ^2`, `client ^2`, `server ^2`. 1.7.5 peers `@modelcontextprotocol/sdk ^1.29.0` |
| `@modelcontextprotocol/server` | 2.3.1 | new split package, also `client` 2.3.1, `core` 2.3.1 |
| `@modelcontextprotocol/hono` | 2.0.2 | peers `hono ^4.11.4`, `server ^2.3.0`; exports `createMcpHonoApp`, host and origin validation middleware |
| `@modelcontextprotocol/node` | 2.1.1 | |
| `@hono/aws-lambda` | 1.0.1 | peer `hono >=4.13.9 or ^5` |
| `hono` | 4.13.13 | |
| `minisearch` | 7.2.0 | MIT |

- Verdict: DIFFERS FROM SPEC. SPEC pairs `@modelcontextprotocol/sdk` with `@modelcontextprotocol/ext-apps` without versions. Today ext-apps 2.x does NOT work with `sdk` 1.x; it needs the v2 split packages (`@modelcontextprotocol/server`). The pair `sdk@1.32.1` plus `ext-apps@1.7.5` is consistent. The pair `server@2.3.1` plus `ext-apps@2.0.3` is consistent. Means for us: pick one stack in T1.5 and pin exact versions. SPEC's INTENT text "repo imports and runs the MCP SDK" is satisfied by either. UNVERIFIED which one Alexa+ (client protocol 2025-03-26) prefers; both servers negotiate. The v2 stack was installed and its types read, but not run.

### 2.3 Stateless server API, v1 stack (installed and run)
- `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`; `registerTool(name, {description, inputSchema}, handler)`.
- `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`: options `sessionIdGenerator` (omit or `undefined` for stateless) and `enableJsonResponse: true`; `handleRequest(req: Request): Promise<Response>`. The type docs show `app.all('/mcp', c => transport.handleRequest(c.req.raw))` for Hono.
- Run on Node 22.14: a new `McpServer` and transport per request, `initialize` and `tools/call` both returned HTTP 200 `application/json`, no `mcp-session-id` header, protocol version 2025-11-25 echoed.
- v1 `LATEST_PROTOCOL_VERSION` is `2025-11-25`; supported list also has 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07.
- Verdict: MATCHES SPEC for stateless JSON responses. Create the server and transport per request (stateless mode cannot share one transport across requests).

### 2.4 Stateless server API, v2 stack (types only)
- `@modelcontextprotocol/server` exports `createMcpHandler`, `WebStandardStreamableHTTPServerTransport`, `PerRequestHTTPServerTransport`, `McpServer`, `requireBearerAuth`, `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata`. `createMcpHandler` serves "once per HTTP request". Not run. UNVERIFIED behavior.

### 2.5 Lambda Function URL with stateless Streamable HTTP
- No MCP or Hono page found that documents "stateless MCP on a Lambda Function URL" end to end. UNVERIFIED as a documented pattern.
- What is documented: the web-standard transport runs on any runtime with `Request` and `Response` (type docs, 2.3); Hono has `handle(app)` in `@hono/aws-lambda` (https://hono.dev/docs/getting-started/aws-lambda), whose CDK example uses `fn.addFunctionUrl({ authType: NONE })`. A buffered Function URL response is fine for single JSON replies. Verified locally only without Lambda or the Hono adapter. Means for us: T1.5 needs one deployed smoke test with 50 warm calls before trusting this.

### 2.6 ext-apps rules (installed v1.7.5 types, 2026-10-18; page https://modelcontextprotocol.io/docs/extensions/apps)
- Tool declares `_meta.ui.resourceUri` pointing at a `ui://` resource. The constant `RESOURCE_URI_META_KEY` in 1.7.5 is `"ui/resourceUri"` (flat key); the Alexa docs and the types example use nested `_meta.ui.resourceUri`. Register through `registerAppTool` and `registerAppResource` so both are written correctly. UNVERIFIED whether Alexa reads the flat key.
- `RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"`.
- `McpUiToolVisibility = "model" | "app"`; `visibility` default is `["model","app"]`; `"app"` means callable by the app from the same server only. Verdict: MATCHES SPEC (`ui_*` tools use `["app"]`).
- `csp` and `permissions` belong on the UI resource (`McpUiResourceMeta`), not the tool; the tool-meta type marks them `never`. Fields: `connectDomains`, `resourceDomains`, `frameDomains`, base URI domains. Empty means no network. Verdict: MATCHES SPEC ("strict csp"), place on the resource.
- Hosts call `resources/read` for the `ui://` URI; the Alexa Local Inspector requires it before `tools/call` (1.10).

---

## 3. Amazon Bedrock Converse

### 3.1 Models and IDs (model cards, read 2026-10-18)
Index: https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html (the "supported models and features for Converse" URL `conversation-inference-supported-models-features.html` now shows the "Models at a glance" index, so a per-model feature grid was not available).

| Model | IDs exactly as printed | us-east-1 and us-west-2 | Structured outputs on bedrock-runtime |
| :--- | :--- | :--- | :--- |
| Claude Haiku 4.5 (launched Oct 16, 2025) | `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `global.anthropic.claude-haiku-4-5-20251001-v1:0`; the model card also prints the base ID `anthropic.claude-haiku-4-5-20251001-v1:0`, but bedrock-runtime needs a geo or global profile (profile use not tested here) | geo and global supported in both; no in-region | Supported |
| Claude Sonnet 4.6 (Feb 17, 2026) | base `anthropic.claude-sonnet-4-6`; `us.anthropic.claude-sonnet-4-6`; `global.anthropic.claude-sonnet-4-6` | geo and global in both | Supported |
| Claude Haiku 5.5 (Oct 7, 2026) | base `anthropic.claude-haiku-5-5`; `us.anthropic.claude-haiku-5-5`; `global.anthropic.claude-haiku-5-5` | geo and global in both | Listed NOT supported |
| Claude Sonnet 5.5 (Sep 28, 2026) | base `anthropic.claude-sonnet-5-5`; `us.anthropic.claude-sonnet-5-5`; `global.anthropic.claude-sonnet-5-5` | geo and global in both | Listed NOT supported |
| Nova 2 Lite (Dec 2, 2025) | base `amazon.nova-2-lite-v1:0`; `us.amazon.nova-2-lite-v1:0`; `global.amazon.nova-2-lite-v1:0` | geo and global in both | Listed NOT supported |

Card URLs: `model-card-anthropic-claude-haiku-4-5.html`, `model-card-anthropic-claude-sonnet-4-6.html`, `model-card-anthropic-claude-haiku-5-5.html`, `model-card-anthropic-claude-sonnet-5-5.html`, `model-card-amazon-nova-2-lite.html`, all under https://docs.aws.amazon.com/bedrock/latest/userguide/.
- Geo US source regions us-east-1 and us-west-2 route to us-east-1, us-east-2 and us-west-2 (Haiku 5.5 card).
- Model cards list Image and Text input only; none lists "Document" as a modality. Document support is described on the Converse page, 3.2.
- Nova Pro, Nova Lite, Nova Micro, Claude Opus 4.x and 5.x, Mythos and Fable exist on the index; their cards were not read. UNVERIFIED for those.
- Third-party Claude models are billed through AWS Marketplace and may need a Marketplace subscription before first use. UNVERIFIED how that works for this account.
- Verdict: MATCHES SPEC ("current Claude or Nova model, verify, no old IDs"). SPEC and the repo contain NO model ID (grep of the repo for `anthropic.`, `amazon.nova`, `modelId`, `MODEL_ID` found none outside docs-verifier text), so nothing to flag as unconfirmed in the repo.
- Means for us: structured outputs and the newest models do not line up. As of the cards, the combination "Converse plus `outputConfig.textFormat` JSON schema" is documented for Haiku 4.5 and Sonnet 4.6, not for Haiku 5.5, Sonnet 5.5 or Nova 2 Lite. Haiku 4.5 EOL is "no sooner than Oct 16, 2026", so confirm it is not in a legacy period before building on it. Make the model ID an env var, and keep zod validation plus one retry regardless (SPEC section 7 already does).

### 3.2 Document input
Source: https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html and https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html
- `document` content block: `name` (1 to 200 chars; letters, digits, single spaces, hyphens, parentheses, square brackets; the docs warn the name can carry prompt injection, so use a neutral name), `source` (union of `bytes`, `content`, `s3Location`, `text`), optional `citations`, `context`, `format`. Valid `format` values: `pdf | csv | doc | docx | xls | xlsx | html | txt | md`.
- A `format` field is required in practice ("Document format is required" error when omitted). A text block must accompany the document in the same message.
- `s3Location` for documents is accepted only on some models; "Other models accept only the `bytes` field and reject an Amazon S3 URI" (stated for images; the DocumentSource page defers to the supported-models page for documents). Nova accepts S3 URIs.
- Count and size: a web search summary of the AWS CLI and boto3 Converse references said up to 5 documents per request and 4.5 MB each; the Nova guide says the 4.5 MB applies to text documents and that PDF and DOCX have no individual limit (25 MB combined direct upload, 2 GB from S3). I did not read those pages in full. UNVERIFIED (search summary only).
- PDF pages: "Claude requires PDF documents to be a maximum of 100 pages per request" (https://docs.aws.amazon.com/bedrock/latest/userguide/inference-api-restrictions.html, read directly).
- Whether a given model reads a PDF visually or only extracts text: UNVERIFIED.
- Citations cannot be combined with structured outputs for Anthropic models (400 error).
- Verdict: SPEC does not say; consistent. Means for us: our own page-numbered text extraction (pdfjs plus Textract) is still needed because Bedrock does not return page numbers by default; send extracted page text, not the PDF, for the cite-or-don't-claim rule. Cap at 100 pages (SPEC cost guard says 40).

### 3.3 Structured output and strict tool use
Source: https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html
- Converse: `outputConfig.textFormat = { type: "json_schema", structure: { jsonSchema: { schema: "<JSON string>", name, description } } }`. The schema is passed as a string.
- Strict tool use: `strict: true` inside `toolConfig.tools[].toolSpec`.
- Supported JSON Schema (2020-12 subset): object, array, string, integer, number, boolean, null; enum; const; anyOf; allOf (limited); internal `$ref`; formats date, date-time, etc.; `minItems` of 0 or 1 only. Not supported: recursion, external `$ref`, `minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, `additionalProperties` other than `false`.
- First use of a new schema compiles a grammar, "may take up to a few minutes"; compiled grammars are cached 24 hours per account. A schema error returns 400 immediately.
- Verdict: DIFFERS FROM SPEC in detail. SPEC section 4 says every quote is "<= 200 chars" and uses strict JSON per zod schema. `maxLength` cannot be in the Bedrock schema, so the 200-char check stays in zod and in `verifySourceRefs`. Every object needs `additionalProperties: false`. Nullable fields need `anyOf` with null. Means for us: generate the JSON Schema from zod with a stripping step; warm each schema once before the demo so the first ingest does not wait for compilation.

---

## 4. Amazon Textract

Source: https://docs.aws.amazon.com/textract/latest/dg/limits-document.html (read directly, 2026-10-18). Pricing page: https://aws.amazon.com/textract/pricing/ (loads; no figures recorded).
- Formats: JPEG, PNG, PDF, TIFF. No XFA PDFs. HEIC is NOT listed.
- Synchronous: JPEG, PNG, PDF and TIFF up to 10 MB in memory; PDF and TIFF limited to 1 page.
- Asynchronous: JPEG and PNG up to 10 MB; PDF and TIFF up to 500 MB and 3,000 pages.
- PDFs: max 40 inches and 9000 points height and width; not password protected. Images: 10000 pixels or less on all sides. Minimum text height 15 pixels (about 8 pt at 150 DPI). Languages: English, French, German, Italian, Portuguese, Spanish; handwriting in English only.
- A separate page (`sync-async.html`) returned a summary that its own model said came from general knowledge; it is ignored here. The asynchronous S3 requirement and SNS usage are therefore not verified from that page. The SPEC statement "async or per-page for PDFs" is still consistent with the limits table.
- Verdict: DIFFERS FROM SPEC. SPEC section 3 allows PDF, JPG, PNG and HEIC uploads. Textract does not accept HEIC. Means for us: convert HEIC to JPEG before storing the OCR input (client-side in the web app, or a conversion step in the ingest worker), or reject HEIC with a clear message. Phone photos over 10 MB need downscaling for the synchronous call. Scanned multi-page PDFs cannot use the synchronous call at all (1 page); split pages into single-page images or use the asynchronous API.

---

## 5. Lambda, Function URLs, Hono, CloudFront

### 5.1 Function URLs
Sources: https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html and `urls-auth.html`.
- URL form `https://<url-id>.lambda-url.<region>.on.aws`. Auth type `AWS_IAM` or `NONE`. CORS can be set on the URL. Throttle by reserved concurrency (max request rate is 10 times reserved concurrency). Public internet only.
- "Starting in October 2025, new function URLs will require both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` permissions." With `NONE`, the resource policy must allow both (the console and SAM add them; CLI, CloudFormation and the API need explicit statements; CDK `addFunctionUrl` behavior UNVERIFIED). Missing permission gives 403 even with `NONE`.
- Verdict: not in SPEC. Means for us: the CDK stack must be checked for both permission statements, or `/mcp` will 403.

### 5.2 Response streaming
Source: https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
- Node.js managed runtimes only. Streaming responses up to 200 MB versus 6 MB buffered. First 6 MB uncapped, then 2 MBps. Not supported by Function URLs inside a VPC. Billed for the full duration even if the client disconnects.
- Hono: `streamHandle(app)` plus `invokeMode: RESPONSE_STREAM` on the URL; `handle(app)` otherwise.
- Verdict: MATCHES SPEC (SPEC does not require streaming). Means for us: use buffered `handle` with `enableJsonResponse: true`; no streaming needed. The SPA bundle limit is the 6 MB buffered response (D-IAC already says revisit at about 2 MB).

### 5.3 CloudFront OAC with Function URLs
Source: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
- OAC requires `AuthType: AWS_IAM`. Grant `cloudfront.amazonaws.com` both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, scoped by distribution ARN (CLI only; the console policy editor is not supported).
- "If you use PUT or POST methods with your Lambda function URL, your users must compute the SHA256 of the body and include the payload hash value in the `x-amz-content-sha256` header... Lambda doesn't support unsigned payloads."
- Verdict: affects D-IAC. D-IAC (SPA served by the api Lambda, no CloudFront) is compatible: a public `NONE` Function URL needs no CloudFront. If CloudFront is added later with OAC, every POST (MCP calls, `/oauth/token`, form posts) would need that header. Alexa+ is not documented to send it, so OAC in front of `/mcp` and `/oauth` should be assumed not to work (inference, not tested). Keep Alexa-facing paths on the direct Function URL or use a non-OAC (public origin) CloudFront setup.

### 5.4 Runtimes
Source: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html
- `nodejs22.x` deprecation Apr 30, 2027; `nodejs24.x` Apr 30, 2028; `nodejs26.x` in public preview (not for production). Node.js 20 is already deprecated.
- Verdict: MATCHES SPEC (Node 22 is supported). Optional: choose `nodejs24.x` to match the Alexa CLI.

### 5.5 Hono adapter
Source: https://hono.dev/docs/getting-started/aws-lambda and the installed `@hono/aws-lambda@1.0.1` types.
- `import { handle, streamHandle } from '@hono/aws-lambda'`. Types `LambdaEvent`, `LambdaContext` via `c.env.event` and `c.env.lambdaContext`. Binary responses are base64 when the content type is binary. The page's example targets `NODEJS_22_X`.
- Verdict: MATCHES SPEC. Lambda event types for Function URLs through the adapter: documented by example only; not run.

---

## 6. Amazon SES

Source: https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html (read 2026-10-18).
- Sandbox (per Region): send only to verified addresses and domains, or the mailbox simulator; at most 200 messages per 24 hours; 1 message per second. From, Source, Sender and Return-Path identities must be verified even in production.
- Production access: console "Request production access" or `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url ... --additional-contact-email-addresses ... --contact-language EN`. Needs mail type, website URL, up to 4 contact emails, language, and an acknowledgement about bounce and complaint handling. Initial response within 96 hours.
- Verdict: MATCHES SPEC ("sandbox is fine for the demo, with verified recipient addresses"). Means for us: verify the demo inbox in the same Region as the sender; do not plan on production access before Oct 22.

---

## 7. MiniSearch

Source: npm `minisearch@7.2.0` (MIT, modified 2025-09-16), installed types and a local run on Node 22.14.
- Package name `minisearch`. Constructor option `fields`, `storeFields`, `searchOptions`.
- Scoring: the types describe "BM25+ algorithm parameters" (`bm25` option with k, b and delta). It is BM25+, a BM25 variant with a lower bound term, not plain Okapi BM25.
- Serialization: `JSON.stringify(miniSearch)` (it has `toJSON`) and `MiniSearch.loadJSON(json, options)` or `loadJSONAsync`; also `loadJS` from `AsPlainObject`. "One must pass to loadJSON the same options" (fields, tokenizer, etc.) used at creation. Functions are not serialized, so the options object must be code shared between build and load.
- Local run: 2,000 clauses of about 10 words, serialized JSON 303,856 bytes, `loadJSON` 20 ms, a three-term search 2.5 ms. The default combine mode is OR (a two-word query matched both documents; `combineWith: 'AND'` matched one). Stop words are not removed by default (the query "is" matched).
- Verdict: MATCHES SPEC ("BM25 e.g. MiniSearch, verify package"), with the precise wording "BM25+". Means for us: set `combineWith: 'OR'` and a score threshold for "nothing relevant found", add a stop-word filter in the `processTerm` option, and store `doc` and `page` as `storeFields`. A 2,000-chunk index of about 300 KB loads in about 20 ms on a laptop. Lambda timing: UNVERIFIED.

---

## 8. CPSC and NHTSA

### 8.1 CPSC Recalls API
Documentation: https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information and the programmer's guide v1.4 dated September 17, 2018 (https://www.cpsc.gov/s3fs-public/RecallRetrievalWebServicesProgrammersGuide20180917.pdf, downloaded and read as text on 2026-10-18).
- Root URI `https://www.saferproducts.gov/RestWebServices/Recall`. Output XML by default, JSON with `format=json`. No API key, rate limit or usage terms are stated anywhere in either document. A variant `.../RecallDelimited` returns pipe-delimited collections.
- The web page documents only these filters by example: `Title`, `RecallDescription`, `ProductName`. The guide lists: RecallID, RecallNumber, RecallDateStart, RecallDateEnd, LastPublishDateStart, LastPublishDateEnd, RecallURL, RecallTitle, ConsumerContact, RecallDescription, ProductName, InconjunctionURL, ImageURL, Injury, Manufacturer, Retailer, Importer, Distributor, ManufacturerCountry, UPC, Hazard, Remedy, RemedyOption. Searches are "case insensitive ... using a wildcard search" (substring match).
- Answer to the question asked: the web page does NOT document `LastPublishDateStart` or a UPC filter; the programmer's guide DOES list both.
- The guide's title filter is `RecallTitle`; the web page example uses `Title`. Which one the server honors: UNVERIFIED (not tested).
- Response fields (guide and live): RecallID, RecallNumber, RecallDate, Description, URL, Title, ConsumerContact, LastPublishDate, Products, Inconjunctions, Images, Injuries, Manufacturers, Retailers, Importers, Distributors, SoldAtLabel, ManufacturerCountries, ProductUPCs, Hazards, Remedies, RemedyOptions.

Observed 2026-10-18 (curl, saved in scratch):
- `?format=json&LastPublishDateStart=2026-10-01` returned HTTP 200, `application/json`, 26 real recalls (most recent RecallNumber 27024, LastPublishDate 2026-10-15). Date format `YYYY-MM-DD` accepted.
- `?format=json&UPC=669028116546` first returned HTTP 200 with the one fake record (RecallID 0, "Error retrieving Recalls: The underlying provider failed on Open.", twice), and on later checks the same day (independent check and a third request) returned HTTP 200 with an empty array `[]` although record 26530 carries exactly that UPC in `ProductUPCs`. So the server-side `UPC` filter is unreliable: it either errors or silently returns nothing. A silent empty result is a false all-clear, so UPCs must be matched client-side.
- Already observed on 2026-10-16 and not contradicted: working params RecallDateStart, RecallDateEnd, RecallNumber, ProductName with `format=json`; failures arrive as HTTP 200 with the single fake record.
- Unknown-parameter behavior ("returns the whole database", SPEC section 10) was re-verified later on 2026-10-18: `format=json&NotAParam=1` returned all 10,053 records, so a result ceiling is required.
- Date filters verified live on 2026-10-18: `LastPublishDateStart=2026-10-01` returned 26 recalls; `LastPublishDateStart=2026-10-01&LastPublishDateEnd=2026-10-08` returned 20; `LastPublishDateEnd=2026-10-08` alone returned 10,047 (almost everything), so an End filter must always be paired with a Start. `RecallDateStart` with `RecallDateEnd` (2026-10-01 to 2026-10-16) returned the same 26 as the Start-only publish query.
- Verdict: MATCHES SPEC for `LastPublishDateStart`, `format=json`, and the allowlist advice. UNVERIFIED for the server-side UPC filter. Means for us: Recall Radar should fetch by `LastPublishDateStart` and match UPCs client-side in the `ProductUPCs` array (as SPEC section 10 already says), and the client must treat RecallID 0 or a Title starting "Error retrieving" as a failure, not a result.

### 8.2 NHTSA
Documentation page https://www.nhtsa.gov/nhtsa-datasets-and-apis (and /node/102181) returned HTTP 403 to WebFetch and to curl with a browser user agent. I could not read it. A web search summary says it documents `recallsByVehicle` with `make`, `model`, `modelYear` and recommends listing years, makes and models first; that is a search summary only.
Observed 2026-10-18 (curl):
- `https://api.nhtsa.gov/recalls/recallsByVehicle?make=ford&model=F-150&modelYear=2020`: HTTP 200, JSON, `Count` 11, `results[]` with `NHTSACampaignNumber`, `Manufacturer`, `Component`, `Summary`, and `ReportReceivedDate` as DD/MM/YYYY ("18/12/2019").
- Blank `model`: HTTP 400 with body `{"Count":0,"Message":"Results returned successfully","results":[]}` (note the message text is misleading). Matches the known observation.
- `https://api.nhtsa.gov/products/vehicle/models?modelYear=2020&make=ford&issueType=r`: HTTP 200, `count` 70, results with `modelYear`, `make`, `model` in upper case make.
- Official rate limits, key requirements and terms: UNVERIFIED (page unreachable). Verdict: MATCHES SPEC for endpoints and the DD/MM/YYYY format; rate limit "1 request per 250 ms" in SPEC is our own choice, not a documented limit.

---

## 9. Devpost rules

Sources: https://amazonappdev2026.devpost.com/ and https://amazonappdev2026.devpost.com/rules, fetched with curl on 2026-10-18 (WebFetch got 403).
- Deadline: Friday, October 23, 2026, 12:00 pm Pacific. Submission period began Monday, August 31, 2026, 10:15 am Pacific. Judging period Nov 9 to Nov 20, 2026. Verdict: MATCHES SPEC and INTENT (hard deadline Fri Oct 23, 12:00 PM PDT; team target Thu 9 PM CT).
- Alexa+ track: "A working Agent Skill or a self-hosted MCP server, implementing MCP spec version 2025-11-25 (or a later version, once confirmed) over Streamable HTTP", or a simulated Alexa+ experience as an alternative. The repo must "actually call" the track technology in code. Verdict: MATCHES SPEC.
- Repository: "either public and open source by including an open source license file OR private and shared with" the Amazon team's GitHub users (collaborator invitations expire after 7 days). A public repo needs the license detectable in the About section. A September 16, 2026 update changed code repository requirements. Verdict: DIFFERS FROM SPEC in a helpful way: public is not the only option, but SPEC's public MIT plan satisfies the first option. Check the license appears in the About box.
- Video: "should be less than three (3) minutes", YouTube or Vimeo, public, shows the project "functioning on the device for which it was built", no third-party trademarks or copyrighted music without permission; materials in English. Verdict: MATCHES SPEC; the footage rule means the demo must show the Alexa+ surface (simulator or device), not only the web app.
- Product feedback required for each tool, API or SDK: what used and for what, what worked, what needs work, onboarding, would build again yes or no with why. AWS Builder entrants describe AWS services and how in the product feedback answer. Verdict: MATCHES SPEC.
- Optional: feature requests with priority; friction log entries with task, steps, expected versus actual, severity, workaround, suggestion. "Up to a 10% bonus", assessed by Amazon's team in Stage 1. Verdict: MATCHES SPEC.
- Mini challenge AWS Builder: any primary-track project incorporating AWS services (Bedrock, AgentCore, Strands SDK, Kiro Crew, SageMaker, etc.) "with documented integrations". Kiro Crew alone qualifies. Verdict: MATCHES SPEC (the services SPEC lists are not required individually).
- Mini challenge Open Source: "a new, additional open-source project (include an open-source license) or a contribution (a branch, a fork, or a pull request)" made in the hackathon window; required fields: contribution URL, project repository URL, GitHub username, description of what you did, how it works and why it matters. Verdict: DIFFERS FROM SPEC. SPEC says a "separate MIT package published". Publishing to npm is not required; a separate public repo with a license is enough. Publishing a package stays optional and still needs the dev's approval (CLAUDE.md). The rule text says "contribute to an existing public repository" and also allows a private repository shared with Amazon for the track itself; a private repo is probably not safe for this mini challenge, so keep the repo public.
- A project can win one track prize and one mini challenge prize. Judging criteria, equally weighted: Tech Implementation, Design, Potential Impact, Quality of the Idea. Verdict: MATCHES INTENT.
- Alexa+ "Creative" examples named in the rules include MCP Apps, cards and carousels, and context-aware add-ons. Prize: Alexa+ track 1st $25,000 cash plus $15,000 AWS credits; mini challenges $5,000 each.
- Pre-existing projects must be "significantly updated" after the start and the changes explained. Our repo history starts inside the window (not checked against Aug 31); confirm the first commit date before submitting.

---

## Mismatches with the project spec

| # | Item | What SPEC says | What the docs say | Source | Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Alexa auth grants | Section 12: one pre-registered client, authorization code, PKCE S256 | Auth page says AS metadata must include `client_credentials` (scope `mcp:service`, 3600 s recommended, no refresh token) for service-level calls; account-linking page says refresh tokens are required with every access token | mcp-toolkit-authentication; mcp-toolkit-account-linking | Add `client_credentials` and refresh tokens to the AS in section 12; test with the real service |
| 2 | SDK pairing | `@modelcontextprotocol/sdk` plus `ext-apps` | sdk latest is 1.32.1; ext-apps 2.0.3 needs `@modelcontextprotocol/server` 2.x; ext-apps 1.7.5 pairs with sdk 1.x | npm view 2026-10-18 | Choose one stack in T1.5 and pin versions; log a Decision |
| 3 | 401 handling | 401 without WWW-Authenticate | Matches Alexa, but the SDK `requireBearerAuth` always sets WWW-Authenticate | bearerAuth.js in sdk 1.32.1 | Write our own bearer check; do not use the SDK middleware |
| 4 | HEIC uploads | Section 3: PDF/JPG/PNG/HEIC | Textract accepts JPEG, PNG, PDF, TIFF only | textract limits-document | Convert HEIC to JPEG before OCR or reject it |
| 5 | alexa-ai CLI | Manifest "if CLI access" | `@alexa-ai/cli` and the Local Inspector are on a private CodeArtifact registry behind an AWS role in Amazon's account; public npm returns 404 | set-up-your-development-environment; npm view | Resolve access with the Alexa Solutions Architect; record D-ALEXA |
| 6 | Docs index URL | `/docs/llms.txt` | HTTP 404 | developer.amazon.com | Drop it from section 15; use sidebar links |
| 7 | Node version | Node 22 | CLI and Local Inspector need Node 24+; Lambda supports 22 and 24 | set-up page; Lambda runtimes | Dev machines need Node 24 for Alexa tools; Lambda stays on 22 or moves to 24 |
| 8 | Structured output models | "Strict JSON ... current Claude or Nova model" | Structured outputs listed on Haiku 4.5 and Sonnet 4.6; listed not supported on Haiku 5.5, Sonnet 5.5 and Nova 2 Lite; no `maxLength`, `minimum`, free `additionalProperties` | Bedrock model cards; structured-output | Use Haiku 4.5 or Sonnet 4.6 ids from 3.1, or validate with zod only; strip unsupported keywords |
| 9 | Open Source mini challenge | Separate MIT package published | New open-source project or a contribution; needs contribution URL, repo URL, GitHub user and description; no package publish required; the repo should be public | Devpost rules | Rewrite the INTENT done-list line; publishing stays optional |
| 10 | Protocol version | Spec 2025-11-25 | Alexa client initializes with 2025-03-26; overview says 2025-11-25 | client-lifecycle; toolkit-overview | Server negotiates down; test an initialize at 2025-03-26 |
| 11 | CPSC filters | Fetch by `LastPublishDateStart` | Web page documents only Title, RecallDescription, ProductName; 2018 guide documents LastPublishDate* and UPC; live UPC filter returned the DB-error record, then an empty array | cpsc.gov; programmer's guide v1.4; curl | Keep LastPublishDateStart plus client-side UPC match; treat RecallID 0 as failure |
| 12 | CloudFront OAC | D-IAC: SPA served by api Lambda | OAC needs AWS_IAM and `x-amz-content-sha256` on POST; no unsigned payloads | CloudFront OAC for Lambda | Keep the direct public Function URL; do not put OAC in front of `/mcp` or `/oauth` |
| 13 | Function URL permissions | Not stated | New URLs need both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` | urls-auth | Check the CDK output has both statements |
| 14 | Retrieval wording | "BM25" | MiniSearch implements BM25+; default OR; no stop-word removal | minisearch 7.2.0 types and run | Say BM25+ in docs; add threshold and stop words |
| 15 | Repo visibility | Public repo | Public with license OR private shared with the Amazon team | Devpost rules | No change needed; public plan stays valid |

## Unverified

- Whether the Alexa `client_credentials` tier is mandatory for an add-on with only user-level tools (pages disagree in scope).
- How to get access to the private `@alexa-ai` registry, and whether entrants are approved automatically.
- Install command for `@alexa-ai/addon-local-inspector` (page defers to the Developer Console).
- Alexa+ web simulator and physical-device access requirements.
- Alexa+ response size limit, tool count limit, timeouts, and support for elicitation, notifications and file uploads from a server.
- Whether Alexa reads the flat `ui/resourceUri` key or only `_meta.ui.resourceUri`.
- `configure-account-linking` flags (`--stage/--client-id` in QuickStart versus `--config-file` in the CLI reference).
- Touch target minimum and button rules (Accessibility and Components pages not read).
- Per-model "Document chat" flag on the Converse feature grid (page now redirects to an index); document count and size limits (search summary only: 5 documents, 4.5 MB for text documents).
- Cards for Nova Pro, Lite, Micro, Opus, Mythos and Fable models; Marketplace subscription steps for Claude on Bedrock.
- Whether strict tool use (`strict: true`) works on Haiku 5.5, Sonnet 5.5 and Nova 2 Lite.
- Stateless MCP on a real Lambda Function URL (local run only), and the v2 SDK stack (types only).
- Textract asynchronous API requirements (S3, SNS) from the documentation (the page read was unreliable).
- CPSC title parameter name (`Title` versus `RecallTitle`), the behavior of unknown parameters today, and CPSC rate limits or terms (none published).
- NHTSA official documentation, rate limits and key requirements (site returns 403 to my tools).
- Whether the repo's first commit falls inside the Devpost submission window.

## Independent check of this file (2026-10-18)

A second agent re-checked the claims that drive decisions against primary sources (curl, `npm view`, AWS and Devpost pages). Confirmed: the Open Source challenge needs no published package and the deadline is Oct 23, 12:00 pm PDT; Textract supports JPEG, PNG, PDF and TIFF only, with synchronous PDF and TIFF limited to 1 page and 10 MB; `@modelcontextprotocol/sdk` 1.32.1 and `ext-apps` 2.0.3 (which peers on the split `@modelcontextprotocol/*` v2 packages, not sdk 1.x) and 1.7.x (peers on sdk 1.29 or newer); `@alexa-ai/cli` and `@alexa-ai/addon-local-inspector` return E404 on public npm; the Alexa docs require `client_credentials` in the AS metadata and refresh tokens, a 401 without `WWW-Authenticate`, and Node 24 or newer for the CLI; the five Bedrock model IDs as printed on their model cards, with structured outputs shown as supported for Haiku 4.5 and Sonnet 4.6 and not for Haiku 5.5, Sonnet 5.5 and Nova 2 Lite (read from the model cards' feature tables, not a Converse page), and a JSON schema subset without `minLength`, `maxLength`, `minimum`, `maximum` or `additionalProperties` other than false; the October 2025 Lambda Function URL permission change; CloudFront OAC needing `AWS_IAM` and `x-amz-content-sha256` on POST; MiniSearch 7.2.0 being BM25+. Corrected above: the `expires_in` wording, the `client_credentials` qualifier, the Haiku 4.5 base ID, the UPC filter behavior, and the public repo note for the mini challenge. Still unverified here: the Alexa 2025-03-26 versus 2025-11-25 protocol discrepancy, SES, NHTSA, the Converse document limits, and which video clause of the rules applies to Alexa+ (the rules text also mentions a Ring device, which looks like another track's wording).
