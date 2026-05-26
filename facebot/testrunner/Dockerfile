FROM node:18-slim

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY package.json .
RUN npm i

COPY . .
RUN npm run build

CMD [ "npm", "test"]
