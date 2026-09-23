#!/usr/bin/env bash
# Exercises the whole system from the outside, as a browser and a relying party would:
# brings the compose stack up, signs alice in, exchanges the code with DPoP, verifies the
# access token against the published JWKS with node:crypto alone, walks the relying party's
# own /login → /callback → /refresh, checks DPoP binding, survives one node down, fails with
# two, and reads every container's log for what must and must not be there.
#
#   scripts/integration-test.sh            # docker compose up --build --wait, then the checks
#   SKIP_UP=1 scripts/integration-test.sh  # against a stack that is already running
set -euo pipefail
cd "$(dirname "$0")/.."

GW=${GW:-http://localhost:3000}
RP=${RP:-http://localhost:3001}
CLI="npx tsx projects/idpFront/cli.ts --gateway $GW"

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }
check() { local name=$1; shift; "$@" >/dev/null 2>&1 && pass "$name" || fail "$name"; }
json() { node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(eval("v"+process.argv[1])))' "$1"; }
jwt_payload() { node -e 'const [,p]=process.argv[1].split(".");process.stdout.write(Buffer.from(p,"base64url").toString())' "$1"; }
strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

echo "== preconditions"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail "node >= 20 is required"
[ -d node_modules ] || npm ci
npm run build --prefix projects/sdk >/dev/null
pass "node $(node -v), sdk built"

if [ "${SKIP_UP:-0}" != "1" ]; then
  echo "== docker compose up --build --wait"
  docker compose up --build --wait
fi

echo "== gateway"
health=$(curl -sf "$GW/health") || fail "gateway /health"
[ "$(echo "$health" | json .status)" = "ok" ] && pass "health ok" || fail "health: $health"
meta=$(curl -sf "$GW/.well-known/openid-configuration")
[ "$(echo "$meta" | json '.response_types_supported[0]')" = "code" ] && pass "discovery: response_types_supported=code" || fail "discovery"
[ "$(echo "$meta" | json .token_endpoint)" = "$GW/token" ] && pass "discovery: token_endpoint" || fail "discovery token_endpoint"
[ "$(echo "$meta" | json '.dpop_signing_alg_values_supported[0]')" = "EdDSA" ] && pass "discovery: DPoP EdDSA" || fail "discovery dpop"
jwks=$(curl -sf "$GW/jwks.json")
[ "$(echo "$jwks" | json '.keys[0].kid')" = "pasta-group-key-1" ] && pass "jwks: kid pasta-group-key-1" || fail "jwks"

echo "== sign-on and token exchange (CLI as browser + relying party)"
access_token=$($CLI --user alice --password password123 --refresh 2>/tmp/idp-cli.err) || { cat /tmp/idp-cli.err; fail "cli sign-on"; }
[ "$(echo "$access_token" | wc -l | tr -d ' ')" = "1" ] && pass "stdout is one line" || fail "stdout"
grep -q '^\[browser\] sign-on' /tmp/idp-cli.err && pass "browser trace on stderr" || fail "browser trace"
grep -q 'password123' /tmp/idp-cli.err && fail "password leaked to the trace" || pass "no password in the trace"

# Independent verification: node:crypto and the published JWK only, no project code.
node - "$access_token" "$jwks" <<'EOF' && pass "access token verifies against JWKS (typ at+jwt, aud demo_client, sub alice, cnf.jkt)" || fail "access token verification"
const crypto = require("node:crypto");
const [token, jwks] = process.argv.slice(2);
const [h, p, s] = token.split(".");
const header = JSON.parse(Buffer.from(h, "base64url"));
const payload = JSON.parse(Buffer.from(p, "base64url"));
const jwk = JSON.parse(jwks).keys.find((k) => k.kid === header.kid);
const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
const ok = crypto.verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
const tampered = crypto.verify(null, Buffer.from(`${h}.${p}x`), key, Buffer.from(s, "base64url"));
if (!ok || tampered) process.exit(1);
if (header.typ !== "at+jwt" || payload.aud !== "demo_client" || payload.sub !== "usr_alice_12345" || !payload.cnf?.jkt) process.exit(1);
if (payload.exp - payload.iat !== 3600) process.exit(1);
EOF

echo "== refusals"
$CLI --user alice --password wrong >/dev/null 2>/tmp/idp-cli.err && fail "wrong password accepted" || pass "wrong password refused"
grep -q 'decrypt failed' /tmp/idp-cli.err && pass "…and it failed at the AEAD tag in the browser" || fail "wrong password reason"
$CLI --user mallory --password x >/dev/null 2>&1 && fail "unknown user accepted" || pass "unknown user refused"
no_dpop=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/token" -d 'grant_type=authorization_code&code=x')
[ "$no_dpop" = "400" ] && pass "/token without DPoP → 400" || fail "/token without DPoP: $no_dpop"
curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/token" -d 'grant_type=authorization_code&code=x' | grep -q 400
curl -s -X POST "$GW/token" -d 'grant_type=authorization_code&code=x' | grep -q invalid_dpop_proof && pass "…error invalid_dpop_proof" || fail "error code"
preflight=$(curl -s -i -X OPTIONS "$GW/token" -H "Origin: $RP" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: DPoP")
echo "$preflight" | grep -qi 'access-control-allow-headers:.*dpop' && pass "CORS preflight allows DPoP for the relying party" || fail "CORS preflight"

echo "== relying party: /login → /authorize → login page → /callback → /refresh"
authorize=$(curl -s -o /dev/null -w '%{redirect_url}' "$RP/login")
echo "$authorize" | grep -q "^$GW/authorize?" && pass "rp /login redirects to the gateway's /authorize" || fail "rp /login: $authorize"
login=$(curl -s -o /dev/null -w '%{redirect_url}' "$authorize")
query=${login#*\?}
param() { node -e 'process.stdout.write(new URLSearchParams(process.argv[1]).get(process.argv[2]) ?? "")' "$query" "$1"; }
c=$(param c); jkt=$(param dpop_jkt); state=$(param state); redirect_uri=$(param redirect_uri)
[ -n "$c" ] && [ -n "$jkt" ] && [ "$redirect_uri" = "$RP/callback" ] && pass "/authorize hands c, dpop_jkt, redirect_uri to the login page" || fail "login page params: $login"
code=$($CLI --user alice --password password123 --jkt "$jkt" --nonce "$c" 2>/dev/null) || fail "login page (CLI --jkt)"
callback=$(curl -s -w '\n%{http_code}' "$RP/callback?code=$code&state=$state")
[ "$(echo "$callback" | tail -1)" = "200" ] && echo "$callback" | grep -q usr_alice_12345 && pass "rp /callback exchanged the code and shows sub" || fail "rp /callback: $(echo "$callback" | tail -3)"
session=$(echo "$callback" | grep -o 'name="session" value="[^"]*"' | sed 's/.*value="//; s/"$//')
refresh=$(curl -s -w '\n%{http_code}' -X POST "$RP/refresh" -d "session=$session")
[ "$(echo "$refresh" | tail -1)" = "200" ] && echo "$refresh" | grep -q usr_alice_12345 && pass "rp /refresh rotated the tokens and shows sub" || fail "rp /refresh"
replay=$(curl -s -o /dev/null -w '%{http_code}' "$RP/callback?code=$code&state=$state")
[ "$replay" = "400" ] && pass "rp refuses a replayed state" || fail "rp replay: $replay"

echo "== threshold: one node down is fine, two is not"
docker compose stop node3 >/dev/null
$CLI --user alice --password password123 >/dev/null 2>&1 && pass "2 of 3 nodes still sign" || fail "2 of 3"
docker compose stop node2 >/dev/null
$CLI --user alice --password password123 >/dev/null 2>&1 && fail "1 of 3 nodes signed" || pass "1 of 3 nodes refused"
docker compose start node2 node3 >/dev/null
docker compose up --wait node2 node3 >/dev/null 2>&1 || true
for _ in $(seq 1 30); do [ "$(curl -s "$GW/health" | json .status)" = "ok" ] && break; sleep 1; done
[ "$(curl -s "$GW/health" | json .status)" = "ok" ] && pass "back to 3 of 3" || fail "nodes did not come back"

echo "== logs"
logs=$(docker compose logs --no-log-prefix 2>/dev/null | strip_ansi)
echo "$logs" | grep -q 'password123' && fail "a container logged the password" || pass "no password in any log"
share=$(json .secretKeyShare < secrets/node-1.json | cut -c1-16)
echo "$logs" | grep -q "$share" && fail "a container logged a key share" || pass "no key share in any log"
gw=$(docker compose logs --no-log-prefix gateway 2>/dev/null | strip_ansi)
echo "$gw" | grep -q 'sign-on .*(no pw)' && pass "gateway: sign-on line says (no pw)" || fail "gateway sign-on line"
echo "$gw" | grep -q 'token .*grant=authz.*access_token' && pass "gateway: token line" || fail "gateway token line"
echo "$gw" | grep -q '(node3 unreachable, excluded)' && pass "gateway: node3 exclusion was logged" || fail "gateway exclusion line"
n1=$(docker compose logs --no-log-prefix node1 2>/dev/null | strip_ansi)
echo "$n1" | grep -q 'sign .*grant=authz.*assertion σ .* ✓' && pass "node1: sign line verified the assertion" || fail "node1 sign line"

echo
echo "all checks passed"
