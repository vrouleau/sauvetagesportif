# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
#
# This file is part of Sauvetage Sportif.
#
# Sauvetage Sportif is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Sauvetage Sportif is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

import zipfile, re
z = zipfile.ZipFile(r'config/template_beach.lxf')
content = z.read(z.namelist()[0]).decode('utf-8')
eids = [int(m) for m in re.findall(r'eventid="(\d+)"', content)]
aids = [int(m) for m in re.findall(r'agegroupid="(\d+)"', content)]
sids = [int(m) for m in re.findall(r'swimstyleid="(\d+)"', content)]
print(f'BEACH swimstyleids: {min(sids)}-{max(sids)} ({len(set(sids))} unique)')
print(f'BEACH eventids: {min(eids)}-{max(eids)} ({len(set(eids))} unique)')
print(f'BEACH agegroupids: {min(aids)}-{max(aids)} ({len(set(aids))} unique)')