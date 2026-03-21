#!/bin/bash
cd '/Users/carl/Dropbox/AI experiments/Pub quiz daily/pubquizdaily'
git add .
git commit -m "${1:-update}"
git push
