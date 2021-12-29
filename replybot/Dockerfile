FROM node:10-stretch

RUN mkdir /app
WORKDIR /app

RUN npm install node-rdkafka
COPY package.json /app
RUN npm install

COPY . /app

CMD [ "npm", "start" ]
