---
name: shared-ui-change
description: Checklist for changing anything in packages/shared-ui (EventsPage, IndividualEntryPage, RelayEntryPage, i18n, HelpTip, api.ts MeetAPI). Use before and after editing shared-ui, because every change must work in both meet-app (Electron) and team-app (web/Docker).
---

# Changing shared-ui

`packages/shared-ui/src` is consumed by both apps:
- **meet-app** via the `@shared` Vite alias (`electron.vite.config.ts`).
- **team-app** via Docker `COPY packages/shared-ui/src` at build time (context `../..`; always run `docker compose` from `packages/team-app/`).

## Layout
- `pages/EventsPage.tsx` — THE shared component (sessions tree + meet editor), single source of truth
- `pages/IndividualEntryPage.tsx`, `pages/RelayEntryPage.tsx`
- `components/HelpTip.tsx` — "?" help bubble (hover/tap, i18n). Use it instead of a bare `title` for anything a user must understand.
- `context/ApiContext.tsx` — `MeetAPI` provider (DI for the data layer); `context/LangContext.tsx` — FR/EN
- `data/api.ts` — `MeetAPI` interface + shared types
- `i18n.ts` — all FR/EN translations; `index.ts` — barrel export

## Checklist
1. **Data layer parity**: if you add/change a `MeetAPI` method in `data/api.ts`, implement it in BOTH `meet-app/src/renderer/src/.../registrationApiElectron.ts` (IPC + `src/main` handler) AND `team-app/frontend/src/meetApi.js` (+ FastAPI endpoint). A method one app lacks must degrade gracefully, not crash.
2. **i18n**: every new string gets FR and EN in `i18n.ts`.
3. **Backend-specific codes**: the UI sends LENEX names (`'PRE'`, `'TIM'`); each backend maps to its own `swimevent.round` codes (meet-app = Splash codes, team-app = its own). Don't leak numeric codes into shared UI.
4. **Gender rules**: age-group gender mirrors its event (never set independently); individual = All/M/F, relay = Mixed/M/F (no All).
5. **Beach vs pool**: tabs/columns hidden for beach (scanner/OCR, rank, best times) — check both meet types.
6. **Hooks gotcha (team-app)**: Vite must NOT set `resolve.preserveSymlinks: true`, or two React instances load and any shared hook crashes (`Cannot read properties of null (reading 'useState')`) — only visible at runtime in a browser.
7. **Verify both apps**: type-check/test meet-app (`npm test` in `packages/meet-app`) and build/test team-app (see `/team-tests`). Use `/meet-tests` and `/team-tests`.
8. If the change touches relay or beach behavior, also read the `relay-entry` / `beach-meet` skills.
