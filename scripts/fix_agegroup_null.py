"""Fix empty ag.name and NULL agemax in COALESCE expressions for age group name display."""
import pathlib

db_ts = pathlib.Path(r"packages/meet-app/src/main/db.ts")
content = db_ts.read_text(encoding="utf-8")

# Fix: COALESCE(ag.name, ...) doesn't handle empty string — use NULLIF
old = "COALESCE(ag.name, CASE WHEN ag.agemin IS NOT NULL THEN ag.agemin || '-' || COALESCE(ag.agemax, '+') END, '???')"
new = "COALESCE(NULLIF(ag.name, ''), CASE WHEN ag.agemin IS NOT NULL THEN ag.agemin || '-' || COALESCE(ag.agemax, '+') END, '???')"

count = content.count(old)
content = content.replace(old, new)
db_ts.write_text(content, encoding="utf-8")
print(f"Replaced {count} occurrences")
