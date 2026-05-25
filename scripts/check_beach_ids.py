import zipfile, re
z = zipfile.ZipFile(r'config/template_beach.lxf')
content = z.read(z.namelist()[0]).decode('utf-8')
eids = [int(m) for m in re.findall(r'eventid="(\d+)"', content)]
aids = [int(m) for m in re.findall(r'agegroupid="(\d+)"', content)]
sids = [int(m) for m in re.findall(r'swimstyleid="(\d+)"', content)]
print(f'BEACH swimstyleids: {min(sids)}-{max(sids)} ({len(set(sids))} unique)')
print(f'BEACH eventids: {min(eids)}-{max(eids)} ({len(set(eids))} unique)')
print(f'BEACH agegroupids: {min(aids)}-{max(aids)} ({len(set(aids))} unique)')
