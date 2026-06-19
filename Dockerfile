FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server ./server
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 19468

CMD ["node", "server/app.js"]
