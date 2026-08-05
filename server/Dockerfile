# pi-cloud-sync server 镜像
FROM node:22-alpine AS build
WORKDIR /app
COPY shared ./shared
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install
COPY server ./server
COPY shared ./shared
RUN cd server && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/shared ./shared
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
