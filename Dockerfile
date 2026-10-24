# Public demo image: the API (MCP, OAuth, web JSON) serves the built web app from one address.
# Synthetic household only, held in memory, so a restart resets it. Not the AWS deployment (infra/ is never deployed).
FROM node:22-slim
ENV CI=true
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --filter @hippo/api... --filter @hippo/web... --frozen-lockfile \
  && pnpm --filter @hippo/web build
# The demo login is off on a public host unless asked; here it is asked for, because the data is synthetic.
ENV HOST=0.0.0.0 HIPPO_DEMO=1 HIPPO_WEB_DIST=/app/apps/web/dist
CMD ["pnpm", "--filter", "@hippo/api", "start"]
