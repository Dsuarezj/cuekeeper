# Ero · cortes — backend vigilante (Fly.io)
FROM node:20-slim
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/ ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
