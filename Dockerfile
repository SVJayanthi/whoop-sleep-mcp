FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV MCP_TRANSPORT=http PORT=3000 WHOOP_TOKEN_FILE=/data/tokens.json
RUN mkdir -p /data && chown node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/cli.js", "serve"]
