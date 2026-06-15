# Meet Reset Behavior: Flush Meet vs Upload Meet (.lxf)

## Flush Meet (Admin → `DELETE /registrations`)

Full reset — prepares the system for a completely new meet cycle.

## Upload Meet (Organizer → `POST /upload/meet`)

Partial reset — replaces the event structure but preserves club/organizer state.

## Comparison

| What | Flush Meet | Upload Meet (.lxf) |
|------|:---:|:---:|
| Delete SwimResult (registrations) | ✅ | ✅ |
| Delete Heat | ✅ | ❌ |
| Delete AgeGroup | ✅ | ✅ |
| Delete SwimEvent | ✅ | ✅ |
| Delete SwimSession | ✅ | ✅ |
| Delete SwimStyle | ❌ | ✅ |
| Delete TeamEvent/Session/Meet | ✅ | ✅ |
| Clear bsglobal keys (MEETVALUES, COMBINEDEVENTS, POINTSCORES) | ✅ | ❌ (overwrites) |
| Reset closure_date / DEADLINE | ✅ | ✅ |
| Reset organizer_club_id | ✅ | ❌ |
| Reset invite_send_count / stripe_send_count | ✅ | ❌ |
| Reset age_base_date | ✅ (Dec 31 current year) | ✅ (from LXF) |
| Remove stored meet.lxf / meet.smb files | ✅ | ❌ (replaces .lxf) |
| Regenerate club PINs | ❌ | ✅ |
| Regenerate combined events | ❌ | ✅ |
| Auto-detect meet_type (pool/beach) | ❌ | ✅ |

## Design Rationale

- **Flush Meet** is destructive: it clears everything so the admin can start fresh, including removing the organizer designation and resetting invitation counts.
- **Upload Meet** is an organizer action to replace the event structure (e.g. updating events for the same meet). It preserves the organizer, clubs, athletes, PINs context, and invitation history because the same people are still involved.
- Club PINs are regenerated on upload to ensure security when sharing a new invitation round (e.g. meet was restructured, re-send invitations with fresh PINs).
