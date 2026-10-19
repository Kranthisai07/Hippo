// A small OAuth 2.1 client for the demo and the tests: authorization code with PKCE S256 against our own server.
// It follows the same steps a browser would (open the login page, press the demo button or send a code, exchange the
// code) with plain fetch, so it works against a local server and against the in-process app.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TokenRequest {
  base: string;
  clientId: string;
  redirectUri: string;
  /** The MCP resource the token is for, for example http://localhost:8787/mcp */
  resource: string;
  scope?: string;
  fetch?: FetchLike;
  /** Omit for the demo button. With an email and a code, signs in with that code (the server log shows it). */
  login?: { email: string; code: string };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

const hidden = (html: string, name: string): string =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

function cookieHeaderOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

export async function getTokens(req: TokenRequest): Promise<Tokens> {
  const doFetch: FetchLike = req.fetch ?? ((url, init) => fetch(url, init));
  const { verifier, challenge } = await makePkce();
  const params: Record<string, string> = {
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    response_type: "code",
    scope: req.scope ?? "mcp:tools",
    state: b64url(crypto.getRandomValues(new Uint8Array(8))),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: req.resource,
  };

  const page = await doFetch(`${req.base}/oauth/authorize?${new URLSearchParams(params)}`);
  if (page.status !== 200) throw new Error(`authorize page returned ${page.status}`);
  const cookie = cookieHeaderOf(page);
  const csrf = hidden(await page.text(), "csrf");

  const post = (extra: Record<string, string>) =>
    doFetch(`${req.base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ ...params, csrf, ...extra }),
    });

  const res = await post(
    req.login ? { action: "login", email: req.login.email, code: req.login.code } : { action: "demo" },
  );
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) throw new Error(`sign in returned ${res.status}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("no authorization code in the redirect");

  const tokenRes = await doFetch(`${req.base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: req.redirectUri,
      client_id: req.clientId,
      code_verifier: verifier,
      resource: req.resource,
    }),
  });
  const body = (await tokenRes.json()) as Record<string, unknown>;
  if (tokenRes.status !== 200 || typeof body.access_token !== "string")
    throw new Error(`token endpoint returned ${tokenRes.status}`);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: Number(body.expires_in),
    scope: String(body.scope ?? ""),
  };
}

/** Asks the server to send a magic code for an email (it goes to the server log in this build) and returns nothing. */
export async function sendMagicCode(req: Omit<TokenRequest, "login"> & { email: string }): Promise<void> {
  const doFetch: FetchLike = req.fetch ?? ((url, init) => fetch(url, init));
  const { challenge } = await makePkce();
  const params: Record<string, string> = {
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    response_type: "code",
    scope: req.scope ?? "mcp:tools",
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: req.resource,
  };
  const page = await doFetch(`${req.base}/oauth/authorize?${new URLSearchParams(params)}`);
  const cookie = cookieHeaderOf(page);
  const csrf = hidden(await page.text(), "csrf");
  await doFetch(`${req.base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ ...params, csrf, action: "send", email: req.email }),
  });
}

/** The service token flow (client_credentials, scope mcp:service). Such a token can never call a tool. */
export async function getServiceToken(req: {
  base: string;
  clientId: string;
  clientSecret: string;
  resource: string;
  fetch?: FetchLike;
}): Promise<string> {
  const doFetch: FetchLike = req.fetch ?? ((url, init) => fetch(url, init));
  const res = await doFetch(`${req.base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: req.clientId,
      client_secret: req.clientSecret,
      scope: "mcp:service",
      resource: req.resource,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200 || typeof body.access_token !== "string")
    throw new Error(`service token returned ${res.status}`);
  return body.access_token;
}
