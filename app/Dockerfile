FROM node:18-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --production
COPY src ./src
EXPOSE 3000
CMD ["node","src/server.js"]
