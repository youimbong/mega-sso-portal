# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# --- 의존성 (dev 포함, 빌드용) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- 빌드 ---
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# --- 운영 의존성만 ---
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# --- 실행 이미지 ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 템플릿과 정적 파일은 컴파일 대상이 아니므로 따로 복사한다.
COPY views ./views
COPY public ./public

USER node
EXPOSE 30400

# 컨테이너 안에서는 모든 인터페이스에 바인딩해야 외부에서 접근된다.
ENV HOST=0.0.0.0
ENV PORT=30400

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:30400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
