FROM node:18-slim

WORKDIR /usr/src/app

COPY package.json /usr/src/app
RUN npm i --omit=dev

COPY . /usr/src/app

CMD [ "npm", "start"]
