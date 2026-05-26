FROM node:18-slim

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY package.json /usr/src/app
RUN npm i

COPY . /usr/src/app

CMD [ "npm", "start"]
