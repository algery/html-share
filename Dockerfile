ARG NODE_BASE_IMAGE=node:24-alpine
FROM ${NODE_BASE_IMAGE} AS workspace

RUN npm install --global pnpm@11.19.0

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/dingtalk/package.json packages/dingtalk/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN --mount=type=cache,id=html-share-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

COPY . .

FROM workspace AS server-build
RUN pnpm db:generate \
  && pnpm build:packages \
  && pnpm --filter @html-share/server build

FROM workspace AS worker-build
RUN pnpm build:packages \
  && pnpm --filter @html-share/worker build

FROM workspace AS web-build
# Next.js replaces NEXT_PUBLIC_* values while building browser bundles. They must
# therefore be provided to the image build, rather than only when the container
# starts. These are intentionally public configuration values, never secrets.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_DEMO_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DINGTALK_CLIENT_ID
ARG NEXT_PUBLIC_DINGTALK_CORP_ID
RUN test -n "$NEXT_PUBLIC_APP_URL" \
  && test -n "$NEXT_PUBLIC_DEMO_URL" \
  && test -n "$NEXT_PUBLIC_API_URL"
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_DEMO_URL=$NEXT_PUBLIC_DEMO_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_DINGTALK_CLIENT_ID=$NEXT_PUBLIC_DINGTALK_CLIENT_ID
ENV NEXT_PUBLIC_DINGTALK_CORP_ID=$NEXT_PUBLIC_DINGTALK_CORP_ID
RUN pnpm build:packages && pnpm --filter @html-share/web build
# Next standalone output omits browser static assets. Place them next to the
# generated server so CSS and client JavaScript resolve from the same runtime.
RUN mkdir -p apps/web/.next/standalone/apps/web/.next \
  && cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

FROM ${NODE_BASE_IMAGE} AS web
WORKDIR /app
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /workspace/apps/web/public ./apps/web/public
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "apps/web/server.js"]

FROM server-build AS server
WORKDIR /workspace/apps/server
ENV NODE_ENV=production
EXPOSE 3001
USER node
CMD ["pnpm", "start"]

FROM worker-build AS worker
WORKDIR /workspace/apps/worker
ENV NODE_ENV=production
EXPOSE 3002
USER node
CMD ["pnpm", "start"]
