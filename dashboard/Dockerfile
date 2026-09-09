# Two stages: build the bundle with Node, serve the static output with nginx.
# The runtime image carries no Node, no source, and no node_modules.

FROM node:20-alpine AS build

WORKDIR /app

# Dependencies first, so a source change does not invalidate the npm layer.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .

# Vite inlines env vars at build time, so the backend URL is a build argument.
ARG VITE_BLUEBERRY_API_URL=http://127.0.0.1:8000
ENV VITE_BLUEBERRY_API_URL=$VITE_BLUEBERRY_API_URL

RUN npm run build


FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1
