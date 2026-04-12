#!/bin/bash
set -e

cd "/Users/carl/code/pubquizdaily/pubquizdaily"

echo ""
echo "⚠️  This will DISCARD local staging changes and reset staging to match main."
read -p "Are you sure? Type YES to continue: " CONFIRM

if [ "$CONFIRM" != "YES" ]; then
  echo "Aborting."
  exit 1
fi

echo ""
echo "Fetching latest from GitHub..."
git fetch origin

echo "Switching to main and updating it..."
git checkout main
git pull origin main

echo "Switching to staging..."
git checkout staging

echo "Resetting staging to match main..."
git reset --hard origin/main

echo ""
echo "✅ Local staging now matches live main."