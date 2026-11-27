# meet-app: how Splash columns are stored

### Splash's encoding (shared Postgres)
Splash reads our rows as-is on a shared Postgres database, so meet-app stores every Splash column the way Splash does — no translation in `.smb` export/restore either:
- `swimevent.round`: Splash codes (`rounds.ts`): 1 TIM, 2 PRE, 6 SEM, 9 FIN, 11 Break
- `swimevent.preveventid`: `-1` for no linked prelim (`NO_PREV_EVENT`; read through `linkedPrelim()`, never truthily)
- `agegroup.agemin/agemax`: `-1` for no limit (`NO_AGE_LIMIT`)
- `dsqitem.options`: Splash's own code (`00000`); our individual/relay tag is in our own `dsqitem.appliesto` (`dsqCodes.ts`)
- course (`swimsession.course`, `entrycourse`, `qtcourse`, MEETVALUES `COURSE`, `MeetCourse`): Splash codes (`courses.ts`): 1 LCM, **2 SCM**, 3 SCY (team-app's are 2 SCY / 3 SCM — the editor and API use the LENEX name); a beach meet's COURSE is 7 (`setBeachCourse`)

Heats: Splash's Results module crashes on a heat `racestatus` it doesn't use (meet-app used to write `4`) and on a NULL `heat.agegroupid`. meet-app stores what Splash stores: seeded = `2` (`HEAT_SEEDED`), validated = `5`, and every heat gets an age group (`fillHeatAgeGroups`: its members' lowest, else the event's first — meet-app itself never reads it). LXF import/new meet/reset keep Splash's own `bsglobal` keys (`clearMeetBsglobal`) — without `BSAPPLICATION`/DDL versions Splash refuses the database ("contains wrong data").
