#!/usr/bin/env bash
# WhatsApp inbound media probe — evidence behind §4 of
# planning/inbound-media.md Appendix A.
#
# Establishes: do WhatsApp media URLs require Bearer auth? what is their real
# TTL? is the media ID still resolvable long after the URL has died?
#
# Usage:  ./whatsapp-media-probe.sh <media_id> [phone_number_id] [ttl]
#           media_id         from a replybot log line: EVENT: {... "image":{"id":...}}
#           phone_number_id  defaults to 1203867182815254 (Track A test number)
#           ttl              pass literally to add the 6-minute expiry test
#
# Optionally set OLD_URL=<lookaside url from the same log line> to also probe a
# webhook-embedded URL with auth.
#
# Reads only — GETs and one read-only SELECT. Never prints the token.

set -uo pipefail

MEDIA_ID="${1:?usage: $0 <media_id> [phone_number_id] [ttl]}"
PHONE_NUMBER_ID="${2:-1203867182815254}"
GRAPH=https://graph.facebook.com/v18.0

echo "== fetching token from credentials (read-only) =="
TOKEN=$(echo "SELECT COALESCE(details->>'access_token', details->>'token') FROM credentials WHERE key = '$PHONE_NUMBER_ID' AND entity = 'whatsapp_business' ORDER BY created DESC LIMIT 1;" \
  | kubectl run -n vprod -i --rm cockroach-client-ro \
      --image=cockroachdb/cockroach:v24.1.28 --restart=Never --pod-running-timeout=5m \
      --command -- ./cockroach sql --insecure --host gbv-cockroachdb-public \
      --database chatroach --format=tsv 2>/dev/null | sed -n '2p' | tr -d '[:space:]')

if [ -z "${TOKEN:-}" ]; then echo "FAILED: no token found"; exit 1; fi
echo "token retrieved (len ${#TOKEN})"
echo

if [ -n "${OLD_URL:-}" ]; then
  echo "== TEST 1a: webhook lookaside URL, BARE =="
  curl -s -o /dev/null -w "  status=%{http_code} type=%{content_type} size=%{size_download}\n" "$OLD_URL"
  echo "== TEST 1b: webhook lookaside URL, WITH Bearer =="
  curl -s -o /dev/null -w "  status=%{http_code} type=%{content_type} size=%{size_download}\n" \
    -H "Authorization: Bearer $TOKEN" "$OLD_URL"
  echo
fi

echo "== TEST 2: resolve media ID via GET /{media_id}, WITH Bearer =="
RESP=$(curl -s -w "\n__STATUS__%{http_code}" -H "Authorization: Bearer $TOKEN" "$GRAPH/$MEDIA_ID")
echo "  status=$(echo "$RESP" | sed -n 's/.*__STATUS__//p')"
BODY=$(echo "$RESP" | sed 's/__STATUS__.*//')
echo "  body (url redacted): $(echo "$BODY" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  if "url" in d: d["url"]="<len %d>" % len(d["url"])
  print(json.dumps(d))
except Exception as e: print("unparsed:", sys.stdin.read()[:200])')"
FRESH_URL=$(echo "$BODY" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("url",""))
except: print("")')
echo

if [ -z "$FRESH_URL" ]; then echo "no fresh URL returned — stopping"; exit 0; fi

echo "== TEST 3: freshly-resolved URL, BARE (no auth) =="
curl -s -o /dev/null -w "  status=%{http_code} type=%{content_type} size=%{size_download}\n" "$FRESH_URL"
echo
echo "== TEST 4: freshly-resolved URL, WITH Bearer =="
curl -s -o /dev/null -w "  status=%{http_code} type=%{content_type} size=%{size_download}\n" \
  -H "Authorization: Bearer $TOKEN" "$FRESH_URL"
echo

if [ "${3:-}" != "ttl" ]; then
  echo "(skipping TTL wait; re-run with 'ttl' arg to measure expiry)"
  exit 0
fi
echo "== waiting 360s to measure real TTL on the resolved URL =="
sleep 360
echo "== TEST 5: same resolved URL after 6 minutes, WITH Bearer =="
curl -s -o /dev/null -w "  status=%{http_code} type=%{content_type} size=%{size_download}\n" \
  -H "Authorization: Bearer $TOKEN" "$FRESH_URL"

unset TOKEN
echo
echo "done."
