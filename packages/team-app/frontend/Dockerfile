FROM node:22-alpine AS build
WORKDIR /app

# Copy shared-ui source
COPY packages/shared-ui/src /shared-ui/src

# Copy frontend
COPY packages/team-app/frontend/package.json ./
RUN npm install
COPY packages/team-app/frontend/ .

# Symlink shared-ui into the frontend src
RUN ln -sf /shared-ui/src src/shared

ARG BUILD_TIMESTAMP=""
RUN apk add --no-cache tzdata && \
    if [ -n "${BUILD_TIMESTAMP}" ]; then echo "${BUILD_TIMESTAMP}" > /tmp/bt; \
    else TZ=America/Toronto date '+%Y-%m-%d %H:%M ET' > /tmp/bt; fi && \
    echo "export const BUILD_TIMESTAMP = '$(cat /tmp/bt)';" > src/buildInfo.js
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY packages/team-app/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY packages/team-app/frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
