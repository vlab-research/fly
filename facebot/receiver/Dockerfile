FROM node:18-bullseye

WORKDIR /usr/src/app

COPY package.json package-lock.json /usr/src/app/
RUN npm ci

COPY . /usr/src/app

EXPOSE 3000
EXPOSE 4000
EXPOSE 4001

CMD [ "npm", "start"]
