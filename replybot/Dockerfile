FROM node:22-bookworm

WORKDIR /usr/src/app

RUN npm install node-rdkafka@2.18.0
COPY package.json /usr/src/app
RUN npm install

COPY . /usr/src/app

CMD [ "npm", "start"]
