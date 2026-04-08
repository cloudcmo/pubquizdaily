#!/bin/bash
set -e

cd "/Users/carl/Desktop/pubquizdaily/pubquizdaily"

echo ""
echo "Switching to staging..."

git checkout staging

CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" != "staging" ]; then
  echo "Error: Not on staging branch"
  exit 1
fi

git pull origin staging

echo ""
echo "Current branch:"
git branch --show-current

git add -A

if git diff --cached --quiet; then
  echo ""
  echo "No changes to commit."
  exit 0
fi

echo ""
read -p "Staging commit message: " MSG
if [ -z "$MSG" ]; then
  echo "No message. Aborting."
  exit 1
fi

git commit -m "$MSG"

echo ""
echo "Pushing to STAGING..."
git push origin staging

echo ""
echo "✅ Done."
echo "Now check your staging / preview site before promoting to main."