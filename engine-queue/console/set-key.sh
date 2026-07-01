#!/bin/bash
# Sets your Supabase anon key into the console page, then optionally redeploys.
# Run from anywhere:  bash set-key.sh
# It will prompt for the key (so it never lands in your shell history).

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
FILE="$DIR/index.html"

if [ ! -f "$FILE" ]; then
  echo "Could not find index.html next to this script."
  exit 1
fi

KEY="$1"
if [ -z "$KEY" ]; then
  printf "Paste your Supabase anon key, then press enter: "
  read -r KEY
fi

if [ -z "$KEY" ]; then
  echo "No key entered. Nothing changed."
  exit 1
fi

KEY="$KEY" perl -0pi -e 's/const SUPABASE_ANON_KEY = "[^"]*";/const SUPABASE_ANON_KEY = "$ENV{KEY}";/' "$FILE"
echo "Anon key set in index.html."

printf "Redeploy to Vercel now? (y/n): "
read -r ANS
if [ "$ANS" = "y" ] || [ "$ANS" = "Y" ]; then
  ( cd "$DIR" && npx vercel deploy --prod )
fi
