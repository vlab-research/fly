FROM node:14-bullseye

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD [ "npm", "start"]
