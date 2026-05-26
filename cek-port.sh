#!/bin/bash

servers=(
  "SG LEASE 1 IP|sglease.xyuzstore.my.id"
  "SG LEASE 2 IP|sglease.xyuzstore.my.id"
  "SG LEASE 3 IP|sglease.xyuzstore.my.id"
  "ID NEVA 1 IP|idneva.xyuzstore.my.id"
  "ID NEVA 2 IP|idneva.xyuzstore.my.id"
  "ID NEVA 3 IP|idneva.xyuzstore.my.id"
)

echo "Cek Status Server"
echo "Update: $(date '+%d %b %Y %H:%M') WIB"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for entry in "${servers[@]}"; do
  nama="${entry%%|*}"
  domain="${entry#*|}"
  domain=$(echo "$domain" | xargs)

  # Cek port 80 atau 443
  timeout 4 bash -c "cat < /dev/null > /dev/tcp/$domain/80"  &>/dev/null 2>&1
  p80=$?
  timeout 4 bash -c "cat < /dev/null > /dev/tcp/$domain/443" &>/dev/null 2>&1
  p443=$?

  if [[ $p80 -eq 0 || $p443 -eq 0 ]]; then
    echo -e "$nama\t\tOnline"
  else
    echo -e "$nama\t\tOffline"
  fi
done
