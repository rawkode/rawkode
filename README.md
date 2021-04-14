# Brian's Modern Life

Welcome! 👋🏻

## Built with CueBlox

This repository contains data that is built with [CueBlox](https://github.com/cueblox/blox). Content and schema are stored in the `/data` directory, and built with a [GitHub Action](.github/workflows/data.yml) on push to `main`. The build output is stored as a draft release with the same name each time, to give it a [consistent path](https://github.com/bketelsen/bkml/releases/download/blox/data.json) that can be referenced from external tools.

The data is available over both REST and GraphQL protocols, served by the tiny web app in the `/websites/api.brian.dev/` directory. It requests the JSON data from the GitHub release and serves it using the brilliant `json-server` and `json-graphql-server` packages.

You can see the end result on Vercel at [GraphQL](https://api.brian.dev/graphql?query=%7B%0A%20%20allPages%20%7B%0A%20%20%20%20title%0A%20%20%7D%0A%7D%0A) or [REST](https://api.brian.dev/pages) that are deployed automatically with any content changes. The result is a read-only database of schema-accurate data validated by CueBlox.

The same content is also deployed on Azure Static Web Apps [GraphQL](https://azure.brian.dev/api/graphql?query=%7B%0A%20%20allPages%20%7B%0A%20%20%20%20title%0A%20%20%7D%0A%7D%0A) or [REST](https://azure.brian.dev/api/pages).

Since the source content is the same, these two sites can be used for redundancy in the event that one of the providers is down.
