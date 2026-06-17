# Config — Shared Configuration Files

## Combined Events (`combined-events-config.json`)

Single source of truth for cumulative point standings. Shared by meet-app (TypeScript `src/main/combinedEvents.ts`) and team-app (Python `backend/app/combined_events.py`). Defines 10 categories for Canadian lifesaving with points scales and age/gender matching rules. **Editable at runtime without rebuild.**

### Event filtering (what gets included)
- Individual events only (`relaycount = 1`)
- Pool events only (`distance >= 25` — excludes throwing events like "Lancer de précision")
- No admin/internal events (`internalevent != 'T'`)
- No finals linked to prelims (`preveventid < 1` — excludes separate final rounds)
- Must have an event number (`eventnumber IS NOT NULL`)

### Category matching
An event matches a category when its age group has:
- Same `agemin` as the category
- Same `agemax` (with -1 meaning no upper limit)
- Same gender (or event gender=0/3 for mixed categories)

## Meet templates

| File | Type | swimstyleid range |
|---|---|---|
| `template_pool.lxf` | Pool (winter) | 500-531 |
| `template_beach.lxf` | Beach (summer) | 601-624 |

Templates are the single source of truth for event structure. They are loaded at meet creation
and reloaded (empty meet, no registrations) after a meet reset or result import:
- **meet-app**: File → Nouveau meet
- **team-app**: Admin → New Meet (pool/beach button), env vars `MEET_TEMPLATE_POOL` / `MEET_TEMPLATE_BEACH`
- **team-app reset**: After result import or admin flush, pool template is reloaded automatically
