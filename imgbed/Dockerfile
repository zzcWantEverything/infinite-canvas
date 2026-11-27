FROM node:20-alpine
WORKDIR /app
COPY server.js .
RUN mkdir -p /data && chown -R node:node /data /app
ENV PORT=8081
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8081
USER node
CMD ["node", "server.js"]
