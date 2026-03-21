#!/bin/bash

cd '/Users/carl/Dropbox/AI experiments/Pub quiz daily/pubquizdaily'

echo "📦 Staging changes..."
git add -A

echo "💬 Enter a commit message (e.g. 'Fixed answer for March 19'):"
read message

git commit -m "$message"

echo "🚀 Pushing to GitHub..."
git push

echo "✅ Done! Netlify will deploy in ~30 seconds."