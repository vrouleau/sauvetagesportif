# Sauvetage Sportif — Monorepo

Monorepo for lifesaving competition management software.

## Structure

```
packages/
  shared-ui/      — Shared React components (events page, meet editor, athletes, etc.)
  meet-app/       — Electron desktop app (SplashMeet replacement)
  team-app/       — Web app (team registration, entries, invoices)
```

## Setup

```bash
npm install
```

## Development

```bash
# Electron app
npm run dev:meet

# Web app
npm run dev:team
```

## Architecture

The `shared-ui` package contains all React UI components that are shared between
the Electron app and the web app. Each app provides its own data layer implementation
via a `MeetAPI` interface passed through React Context.

- **meet-app**: Data comes from local SQLite via Electron IPC
- **team-app**: Data comes from FastAPI backend via HTTP fetch
