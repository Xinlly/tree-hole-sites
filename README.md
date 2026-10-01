# Tree Hole Sites

A self-hosted Next.js app for the tree-hole (anonymous message board) sites.
Data is stored in a local SQLite database through `better-sqlite3`; no
Cloudflare bindings are required.

## Prerequisites

- Node.js `>=22.13.0`

## Configuration

Configure the site with environment variables:

- `TREE_HOLE_PASSWORD`: password visitors use to unlock the site.
- `TREE_HOLE_ADMIN_PASSWORD`: separate admin password. Falls back to
  `TREE_HOLE_PASSWORD` when unset.
- `TREE_HOLE_DB_PATH`: SQLite database file path. Defaults to
  `./data/tree-hole.db`; the parent directory is created on first use.

Sessions are kept in HttpOnly cookies.

## Getting Started

```bash
npm install
npm run dev
# production
npm run build
npm run start
```

`npm run build` emits a standalone server under `.next/standalone`, which can be
run directly with `node .next/standalone/server.js`.

## Project Shape

- `app/`: Next.js App Router pages and API routes.
- `db/`: Drizzle schema and SQLite client (`db/schema.ts` starts empty).
- `examples/d1/`: reference D1 example code, not part of the running app.
- `drizzle.config.ts`: local migration generation.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: build the app and emit the standalone server
- `npm test`: build and run the test suite (store unit tests and HTTP
  end-to-end tests against the standalone server)
- `npm run lint`: run ESLint
- `npm run db:generate`: generate Drizzle migrations after schema changes
