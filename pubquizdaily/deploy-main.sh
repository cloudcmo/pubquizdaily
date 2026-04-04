#!/bin/bash
set -e

cd "/Users/carl/Dropbox/AI experiments/Pub quiz daily/pubquizdaily"

echo ""
echo "Preparing to move tested code from staging to main..."

if [ -n "$(git status --porcelain)" ]; then
  echo "You have uncommitted changes. Commit or stash them first."
  exit 1
fi

git checkout staging
git pull origin staging

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "staging" ]; then
  echo "Error: Not on staging branch"
  exit 1
fi

git checkout main
git pull origin main

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Error: Not on main branch"
  exit 1
fi

echo ""
echo "About to merge staging into main."
read -p "Push merged code to LIVE main branch? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "Aborting."
  exit 1
fi

git merge --no-ff staging -m "Promote staging to main"
git push origin main

echo ""
echo "✅ Pushed to MAIN."
echo "Netlify should now deploy the live site."