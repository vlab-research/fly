FROM node:22-bookworm

WORKDIR /usr/src/app

# `npm ci` against a committed lockfile, not `npm install` against package.json
# alone: 13 of the 15 runtime deps are floating ^ ranges, so the old form
# re-resolved them from the registry on every build and the same git tag could
# ship different dependency versions on different days.
#
# This also drops a `RUN npm install node-rdkafka@2.18.0` line that used to sit
# above the COPY, keeping that slow native compile in a layer that almost never
# invalidated. `npm ci` deletes node_modules before installing, so the layer
# could not have survived it. No version is lost: node-rdkafka arrives as a
# transitive dep of @vlab-research/botspine at ^2.10.0, and the lockfile pins
# exactly the v2.18.0 that line was asking for -- which plain `npm install` was
# free to resolve straight past. The compile now happens inside `npm ci`, whose
# layer release.yml caches (cache-to: type=gha) and which invalidates only when
# package.json or the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . /usr/src/app

CMD [ "npm", "start"]
