FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS production
RUN corepack enable pnpm
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 3016
ENV PORT=3016
CMD ["node_modules/.bin/tsx", "src/index.ts"]
