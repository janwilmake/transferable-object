# June 16, 2025

- Created first implementation with `/export`, `/import`
- Added `/dump` and `/clear` and `clone` functionality
- Tested dumping in cronjob, works pretty well, however, it's not certain the .sql statements contain no syntax errors

# June 23, 2025

- Learned that it's actually very delicate as we need full SQL parsing to achieve what I tried, because of the limitations: 2mb rowsize, 100kb statementsize, 100 parameters binded max! see https://x.com/janwilmake/status/1937092172068913402
- After testing this in practice, i found that it's hard to make a low-bundle-size SQLite parser. https://x.com/janwilmake/status/1937113870067282129
- Removed dumping functionality, exporting into `.sql`, and importing from sql completely. It's a huge amount of complexity and doesn't work
- Created `/transfer/import/{url}` that imports from a `/query/stream`-enabled server.

# June 24, 2025

✅ Tried improving SQLite dump functionality further, found that it's HARD. Created a simplified approach

✅ Test pulling from remote `https://markdownfeed.com/do/v3-pub` and see if this is reliable.

✅ Make a post about more robust simplified `transferable-object`.
