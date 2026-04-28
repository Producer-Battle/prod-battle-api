ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

FROM base AS runtime
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
ENV PORT=8080
# ffmpeg: oggToWav (admin/flip-sources/generate, admin/sample-packs/generate)
# ca-certificates: TLS verification of outbound SMTP (Let's Encrypt chain on
#   mail.prodbattle.com:465). Alpine's base image ships without it; without
#   it, nodemailer's TLS handshake to Mailu silently stalls until Mailu drops
#   the connection ("no auth attempts in 5 secs" in submission-login logs).
RUN apk add --no-cache ffmpeg ca-certificates
RUN addgroup -S app && adduser -S -G app app
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod=true
COPY --from=build /app/dist ./dist
USER app
EXPOSE 8080
CMD ["node", "dist/server.js"]
