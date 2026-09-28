#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
WEB="http://127.0.0.1:${WEB_PORT:-8080}"

docker compose up -d --build
trap '[ "${KEEP:-1}" = 0 ] && docker compose down -v >/dev/null 2>&1 || true' EXIT

echo "waiting for the seeder to finish"
code=$(docker compose wait seed | grep -oE "[0-9]+$" | tail -1)
docker compose logs seed --no-log-prefix
[ "$code" = 0 ] || { echo "seeder failed with $code"; exit 1; }

for _ in $(seq 1 30); do
  body=$(curl -fsS "$WEB/api/notes") && echo "$body" | grep -q 'Weekend ideas' && break
  sleep 1
done

echo "$body" | node -e '
  const { notes } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const by = Object.fromEntries(notes.map((n) => [n.title, n]));
  const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
  console.log(notes.map((n) => `  uid ${String(n.uid).padStart(2)}  ${n.title}`).join("\n"));
  if (notes.length !== 6) fail(`expected 6 notes, got ${notes.length}`);
  if (by["Parking spot"]) fail("the deleted note is still there");
  if (!by["Groceries"]?.excerpt.includes("Basil")) fail("the Groceries edit did not arrive");
  if (!by["Standup notes, Tuesday"]?.excerpt.includes("staging database")) fail("the Standup edit did not arrive");
  if (by["Road trip, coast route"]?.attachments.length !== 1) fail("attachment metadata missing");
  console.log("OK: 6 notes, 2 edits applied, 1 delete applied, attachment metadata present");
'

logs=$(docker compose logs app --no-log-prefix)
echo "$logs" | grep -q 'plan=incremental.*updated=1.*triggers=new-messages,expunge' \
  || { echo "FAIL: no IDLE-driven edit pass in the app log"; exit 1; }
echo "$logs" | grep -q 'plan=incremental.*deleted=1.*triggers=expunge' \
  || { echo "FAIL: no IDLE-driven delete pass in the app log"; exit 1; }
echo "OK: edits and the delete were driven by IDLE events, not by the periodic resync"
