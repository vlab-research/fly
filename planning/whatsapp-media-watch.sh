#!/usr/bin/env bash
# Watch for a fresh inbound WhatsApp media event and probe it INSIDE the ~302s
# URL lifetime. Token is fetched once up front and held in memory so the probe
# fires within seconds of the event landing.
#
# The one test yesterday's run could not do: a FRESH webhook lookaside URL,
# unauthenticated. That is the gap this closes.

set -uo pipefail
SP="${TMPDIR:-/tmp}/wa-media-watch"; mkdir -p "$SP"
OUT="$SP/watch_result.txt"
GRAPH=https://graph.facebook.com/v18.0
DEADLINE=$(( $(date +%s) + 1500 ))   # give up after 25 min

: > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }

TOKEN=$(echo "SELECT COALESCE(details->>'access_token', details->>'token') FROM credentials WHERE key = '${1:-1203867182815254}' AND entity = 'whatsapp_business' ORDER BY created DESC LIMIT 1;" \
  | kubectl run -n vprod -i --rm cockroach-client-ro \
      --image=cockroachdb/cockroach:v24.1.28 --restart=Never --pod-running-timeout=5m \
      --command -- ./cockroach sql --insecure --host gbv-cockroachdb-public \
      --database chatroach --format=tsv 2>/dev/null | sed -n '2p' | tr -d '[:space:]')
[ -z "${TOKEN:-}" ] && { say "FAILED: no token"; exit 1; }
say "token ready (len ${#TOKEN}); watching for inbound WhatsApp media…"

PODS=$(kubectl get pods -n vprod -o name 2>/dev/null | grep replybot)

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  EV=""
  for p in $PODS; do
    line=$(kubectl logs -n vprod "$p" --since=90s 2>/dev/null \
            | grep 'lookaside' | tail -1)
    [ -n "$line" ] && { EV="$line"; break; }
  done

  if [ -z "$EV" ]; then sleep 12; continue; fi

  FOUND_AT=$(date +%s)
  say ""
  say "=== media event detected at $(date -u +%H:%M:%SZ) ==="
  echo "$EV" | sed 's/^EVENT:  //' > "$SP/live_event.json"

  fld() { python3 -c "
import json,sys,re
d=json.load(open('$SP/live_event.json'))
t=d.get('type','')
m=d.get(t,{}) if isinstance(d.get(t),dict) else {}
u=m.get('url','')
f='$1'
if f=='mid': print(m.get('id',''))
elif f=='mime': print(m.get('mime_type',''))
elif f=='evts': print(d.get('timestamp',0)//1000)
elif f=='ext':
    r=re.search(r'ext=(\d+)',u); print(r.group(1) if r else 0)
elif f=='url': print(u)
" 2>/dev/null; }

  MID=$(fld mid); MIME=$(fld mime); EVTS=$(fld evts); EXT=$(fld ext); URL=$(fld url)
  HASURL=0; [ -n "$URL" ] && HASURL=1

  say "  type/mime : $MIME"
  say "  media_id  : $MID"
  say "  url field present: $HASURL"
  if [ "$EXT" != "0" ]; then
    say "  ext - event_ts = $(( EXT - EVTS ))s   (age at probe: $(( FOUND_AT - EVTS ))s)"
  fi

  if [ "$HASURL" = "1" ]; then
    say ""
    say "-- T1: FRESH webhook lookaside URL, NO AUTH  <-- the gap"
    say "   $(curl -s -o /dev/null -w 'status=%{http_code} type=%{content_type} size=%{size_download}' "$URL")"
    say "-- T2: FRESH webhook lookaside URL, WITH Bearer"
    say "   $(curl -s -o /dev/null -w 'status=%{http_code} type=%{content_type} size=%{size_download}' -H "Authorization: Bearer $TOKEN" "$URL")"
  else
    say "  (no url field on this event — notable in itself)"
  fi

  say ""
  say "-- T3: GET /{media_id} with Bearer"
  RESP=$(curl -s -w '\n__S__%{http_code}' -H "Authorization: Bearer $TOKEN" "$GRAPH/$MID")
  say "   status=$(echo "$RESP" | sed -n 's/.*__S__//p')"
  BODY=$(echo "$RESP" | sed 's/__S__.*//')
  say "   body(url redacted): $(echo "$BODY" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  if "url" in d: d["url"]="<len %d>"%len(d["url"])
  print(json.dumps(d))
except: print("unparsed")')"
  FRESH=$(echo "$BODY" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("url",""))
except: print("")')

  if [ -n "$FRESH" ]; then
    say "-- T4: resolved URL, NO AUTH"
    say "   $(curl -s -o /dev/null -w 'status=%{http_code} size=%{size_download}' "$FRESH")"
    say "-- T5: resolved URL, WITH Bearer"
    say "   $(curl -s -o /dev/null -w 'status=%{http_code} type=%{content_type} size=%{size_download}' -H "Authorization: Bearer $TOKEN" "$FRESH")"
  fi

  say ""
  say "=== probe complete ==="
  unset TOKEN
  exit 0
done

say "no inbound WhatsApp media seen before deadline."
unset TOKEN
exit 2
