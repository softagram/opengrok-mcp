FROM node:22.12-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm install
RUN npm run build

FROM node:22.12-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

ENTRYPOINT ["node", "dist/index.js"]
