"""Add name attributes to beach template age groups."""
import pathlib

p = pathlib.Path("scripts/create_beach_template.py")
c = p.read_text(encoding="utf-8")

replacements = {
    'agegroupid="6002" agemax="12" agemin="11"': 'agegroupid="6002" agemax="12" agemin="11" name="11-12 ans"',
    'agegroupid="6004" agemax="14" agemin="13"': 'agegroupid="6004" agemax="14" agemin="13" name="13-14 ans"',
    'agegroupid="6006" agemax="14" agemin="13"': 'agegroupid="6006" agemax="14" agemin="13" name="13-14 ans"',
    'agegroupid="6008" agemax="14" agemin="13"': 'agegroupid="6008" agemax="14" agemin="13" name="13-14 ans"',
    'agegroupid="6010" agemax="14" agemin="13"': 'agegroupid="6010" agemax="14" agemin="13" name="13-14 ans"',
    'agegroupid="6012" agemax="18" agemin="15"': 'agegroupid="6012" agemax="18" agemin="15" name="15-18 ans"',
    'agegroupid="6014" agemax="18" agemin="15"': 'agegroupid="6014" agemax="18" agemin="15" name="15-18 ans"',
    'agegroupid="6016" agemax="18" agemin="15"': 'agegroupid="6016" agemax="18" agemin="15" name="15-18 ans"',
    'agegroupid="6018" agemax="18" agemin="15"': 'agegroupid="6018" agemax="18" agemin="15" name="15-18 ans"',
    'agegroupid="6020" agemax="18" agemin="15"': 'agegroupid="6020" agemax="18" agemin="15" name="15-18 ans"',
    'agegroupid="6022" agemax="-1" agemin="19"': 'agegroupid="6022" agemax="-1" agemin="19" name="Open"',
    'agegroupid="6024" agemax="-1" agemin="19"': 'agegroupid="6024" agemax="-1" agemin="19" name="Open"',
    'agegroupid="6026" agemax="-1" agemin="19"': 'agegroupid="6026" agemax="-1" agemin="19" name="Open"',
    'agegroupid="6028" agemax="-1" agemin="19"': 'agegroupid="6028" agemax="-1" agemin="19" name="Open"',
    'agegroupid="6030" agemax="-1" agemin="19"': 'agegroupid="6030" agemax="-1" agemin="19" name="Open"',
    'agegroupid="6102" agemax="12" agemin="11"': 'agegroupid="6102" agemax="12" agemin="11" name="11-12 ans"',
    'agegroupid="6104" agemax="14" agemin="13"': 'agegroupid="6104" agemax="14" agemin="13" name="13-14 ans"',
    'agegroupid="6106" agemax="14" agemin="13"': 'agegroupid="6106" agemax="14" agemin="13" name="13-14 ans"',
}

for old, new in replacements.items():
    c = c.replace(old, new)

p.write_text(c, encoding="utf-8")
print("Done - added names to age groups")
