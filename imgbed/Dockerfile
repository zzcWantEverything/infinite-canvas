FROM node:20-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8081
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8081
CMD ["node", "server.js"]
