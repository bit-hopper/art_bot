# Africana art bot

Posts one Africana artwork an hour to Bluesky/AT Protocol, picked from open museum collections. Each post is the image, a short caption, and a reply with the museum's credit and a link to the object page. German and French descriptions are auto-translated with DeepL and marked "[auto-translated]". Threads integration is scheduled next.

## Sources

Staatliche Museen zu Berlin, The Met, Cleveland Museum of Art, Art Institute of Chicago, Minneapolis Institute of Art, Smithsonian National Museum of African Art, and the Louvre. Objects made in Africa are in scope, which includes ancient Egypt. Human remains and some other categories are filtered out (see `config/denylist.yaml`, `config/filters.yaml`).

## How it works

- `src/build-index.ts` crawls each museum and writes a compact index of postable objects (daily).
- `src/run.ts` picks one object (`src/selector.ts`: object-class weights, an Egypt share cap, no repeats), renders the post, publishes it, and records it in a ledger.
- Everything runs on GitHub Actions. The index and the ledger live on the `state` branch, so `main` holds only code. They list museum object ids and post links, nothing sensitive.

| Workflow            | When                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `post-hourly`       | minute 17 every hour (GitHub's schedule, plus an external dispatch from cron-job.org because GitHub drops runs) |
| `build-index-daily` | 03:40 UTC                                                                                                       |
| `health`            | hourly: opens an `alert` issue if nothing posted for 3 hours or an index is stale                               |
| `keepalive`         | monthly, stops GitHub disabling the schedules                                                                   |

A minimum-gap guard (40 minutes) means several triggers in one hour still produce one post.

## Running it

Needs Node 22.

```
npm ci
npm test                 # unit tests
npm run typecheck
npm run build-index met  # build one source's index into ./state
npm run dry-run          # render a post, publish nothing
```

`DRY_RUN=0 npm run dry-run` posts for real and needs `BSKY_IDENTIFIER` and `BSKY_APP_PASSWORD` in the environment.

## Configuration

- `config/sources.yaml`: which museums are enabled and their crawl settings
- `config/filters.yaml`: class weights, share caps, posting rules
- `config/denylist.yaml`: objects and terms never posted

Repository secrets: `BSKY_IDENTIFIER`, `BSKY_APP_PASSWORD`, `DEEPL_API_KEY`.
Repository variables: `BOT_USER_AGENT`, `PAUSED` (`true` stops posting), `LIVE` (`true` allows real posts; unset means dry runs only).

## Licensing

The artworks and images belong to the museums, not to this project. The bot posts for educational purposes only and is strictly non-commercial. Every post credits the museum and links to the object page, and carries the museum's own rights wording (for example CC0, public domain, or CC BY-NC-SA). Objects without an open license are still posted, with the museum's rights statement as it stands, so an image may be "all rights reserved" or "in copyright". The bot blocks only objects with no image and the sensitive-object denylist (human remains, sacred or restricted items).
