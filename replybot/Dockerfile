FROM node:12-stretch

WORKDIR /usr/src/app

RUN npm install node-rdkafka@2.10.1
COPY package.json /usr/src/app
RUN npm install

COPY . /usr/src/app

CMD [ "npm", "start"]
