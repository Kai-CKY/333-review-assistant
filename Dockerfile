FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .native-build python3 make g++ \
    && npm ci --omit=dev \
    && apk del .native-build

COPY apps/api ./apps/api
COPY apps/web ./apps/web

ENV NODE_ENV=production
ENV PORT=3333
ENV HOST=0.0.0.0

EXPOSE 3333

CMD ["node", "apps/api/src/server.js"]
