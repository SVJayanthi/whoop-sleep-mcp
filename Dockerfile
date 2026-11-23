FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV MCP_TRANSPORT=http MCP_MODE=hosted PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/cli.js", "serve"]
