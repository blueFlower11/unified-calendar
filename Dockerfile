FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=3000 DB_FILE=/data/data.sqlite
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "server.js"]
