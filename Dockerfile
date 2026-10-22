FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p reports && chown -R node:node reports
ENV NODE_ENV=production PORT=8080 TRUST_PROXY=1
USER node
EXPOSE 8080
CMD ["node", "server.js"]
