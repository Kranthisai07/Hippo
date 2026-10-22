# Submission pack

Paste targets for the Devpost form. The text below is written for hackathon judges. Every claim is something the repo does today; the limits are stated in the last section and must stay in the post.

## Devpost project description (about 570 words)

**Hippo turns the paperwork a household never reads twice into dated obligations, and watches them while nobody is talking.**

**The problem.** The cost of household paperwork shows up as missed deadlines: a lease notice window that closed, a warranty that ran out three weeks before the dishwasher leaked, a subscription that renewed at full price, a recalled product still in use. Alexa+ can store notes and answer questions about documents. It does not turn them into dated obligations, join them (this item, this receipt, this warranty, this exclusion), or watch them in the background.

**What Hippo does.**

1. *Upload to deadline.* Drop a lease PDF into the web app. It shows "Give notice by Nov 1" with the quoted clause and page. You confirm the date, and only then does it become an obligation that can alert.
2. *Coverage by voice.* "My dishwasher is leaking, am I covered?" The answer says yes, in warranty until a date, but water damage from improper installation is excluded (page 3), and how to file within 30 days. Every document based answer cites the document and the page.
3. *Proactive catch.* The next question starts with one sentence: "Before that, your car insurance renews in 9 days." A daily job also checks real CPSC and NHTSA recall data against your things and builds an email digest.

**How it is built.** A self hosted MCP server over stateless Streamable HTTP with nine tools, an OAuth 2.1 server (PKCE S256, resource binding, rotating refresh tokens with family revocation), a React web app for upload and review, and a daily job. Tool handlers make no model calls and no outbound HTTP, so a voice answer is a lookup (p95 under 150 ms measured locally). Hard rules are tested, not just stated: no alert from an unconfirmed date, every extracted field must quote the page it cites or it is dropped, policy and account numbers are masked to the last 4, the household always comes from the token and never from a tool argument, and text inside a document is treated as untrusted data. More than 3,000 automated tests cover this, after three rounds of independent adversarial review.

**Built in the hackathon window.** Everything in the repository, including a CDK stack that was synthesized and template tested but never deployed.

**Alexa+ track, and what we could not do.** The Alexa+ developer tools are partner only, so we could not run Hippo on a real Alexa+ client. The demo is a web page (/ask) that acts as a real MCP client against the same server, with plain React cards drawn from the tool results (not the MCP Apps host bridge). The server is plain MCP and runs on any client.

**Honest limits.** The default build reads only the six demo documents. The Bedrock and Textract adapters exist with a call cap and timeouts, but a live document extraction never ran: AWS refused it on our account (every daily token quota was 0 and not adjustable; case 179260044300224 was still open when we stopped waiting). One real SES digest was sent and one Textract page was read. Nothing is deployed; it runs locally. DynamoDB is verified only against DynamoDB Local. Sessions and auth state are in memory.

**Run it.** `pnpm install`, `pnpm dev`, `pnpm dev:web`, open http://localhost:5173 (steps and the 2:45 demo path are in the README and docs/DEMO_SCRIPT.md). Our product feedback and friction log (22 entries) are in docs/PRODUCT_FEEDBACK.md and docs/FRICTION_LOG.md.

## Open Source challenge fields

- Repository: https://github.com/Kranthisai07/Hippo (public, MIT license)
- GitHub username: Kranthisai07
- What: Hippo, an MIT licensed household obligations engine: a deadline engine, a source quote check that drops any field whose quote is not on the cited page, recall matchers for CPSC and NHTSA, an MCP server with OAuth 2.1, a web app and a daily job.
- How it is reusable: `packages/obligation-kit` has no dependencies, no network and no clock (today is a parameter), so it can be dropped into other projects. Fixtures, expected extractions and a friction log are included.
- Why: Document based assistants answer questions but do not track dated obligations. The code is open so others can check the safety rules (confirm before alert, cite the page, mask numbers) and reuse the parts.
- Contribution URL: the repository link above (confirm on the form whether a specific PR or folder link is wanted; `packages/obligation-kit` is the most reusable part).

## Challenges to enter

- Alexa+ track: yes.
- Open Source: yes.
- AWS Builder: **do not enter.** It needs a real Bedrock call and none ran (MEMORY.md D-058).

## K's checklist before 9:00 PM CT Thursday Oct 22

1. Merge the open PR for `k/final2` (the reviewer verdict is in the PR thread), then confirm CI is green on the merge commit.
2. Record the video: under 3:00, public (YouTube or Vimeo), English, no third party music. Follow docs/DEMO_SCRIPT.md. Restart the API before the proactive moment (it shows only on the first eligible call).
3. Optional for the video: the SES digest email you received.
4. Repository settings: public, MIT license visible in About, a one line About description.
5. Tag `v1.0.0` on the final main commit (ask Claude to do it after you approve).
6. Devpost form: paste the description above, add the repository and video links, the product feedback and friction log links, tick the challenges listed above, submit before the deadline (hard limit Fri Oct 23, 12:00 PM PDT).
