#!/bin/sh
# test/stack.sh up|down|logs   the test stack by hand
cd "$(dirname "$0")/.."
action=$1
files="-f docker-compose.yml -f test/docker-compose.yml"
case "$action" in
  up) docker compose --env-file test/test.env $files -p s3lab-test up -d ;;
  down) docker compose --env-file test/test.env $files -p s3lab-test down -v ;;
  logs) docker compose --env-file test/test.env $files -p s3lab-test logs --tail "${TAIL:-40}" lab ;;
esac
