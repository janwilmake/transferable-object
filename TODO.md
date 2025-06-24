# DO-DX

✅ I need to be sure that there are no old active DOs. Looking at the sql dump, it seems this might be the case. I made a `dodash.ts` script to be able to delete the instances in production!

✅ Do a full download of my prod SQLite data to localhost through a bun script using the new `clone` utility function. I need to be able to easily get my prod data into localhost. For now, `v3-pub` is enough.

✅ Tried improving SQLite dump functionality further, found that it's HARD. Created a simplified approach

Expose `/do/{id}` as basepath for any direct DO request (with auth)

Test pulling from remote `https://markdownfeed.com/do/v3-pub` and see if this is reliable

Make a post about more robust simplified `transferable-object`.

Maybe add `/dump` and `/export` again, but this time writing to JSON/JSONL as this is much easier to write and parse twice. Very nice to have.

Allow import from JSON/JSONL as well.
