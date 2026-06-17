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

"""Generate template_beach.lxf — a minimal beach meet template.

Beach events use the 'distance' field as max participants per heat.
Event names describe the actual distance (e.g. "Beach Sprint 90m").
Swimstyle IDs use 6xx range to avoid conflicts with pool (5xx).
Event/agegroup IDs use 6xxx range.
"""
import zipfile
import io
from pathlib import Path

TEMPLATE_XML = '''<?xml version="1.0" encoding="UTF-8"?>
<LENEX revisiondate="2026-05-23" created="2026-05-23T10:00:00" version="3.0">
  <CONSTRUCTOR name="SauvetageMeet" registration="Société de Sauvetage" version="1.0.0">
    <CONTACT name="Société de sauvetage" country="CA" />
  </CONSTRUCTOR>
  <MEETS>
    <MEET name="Championnats Plage" course="SCM" deadline="2026-06-01" reservecount="0" startmethod="1" timing="MANUAL" masters="F" state="QC" nation="CAN">
      <AGEDATE value="2026-12-31" type="DATE" />
      <SESSIONS>
        <SESSION date="2026-07-12" daytime="08:00" name="Samedi - Éliminatoires" number="1">
          <EVENTS>
            <EVENT eventid="6001" number="1" order="1" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="601" name="Beach Flags" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6002" agemax="12" agemin="11" name="11-12 ans" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6003" gender="F" number="2" order="2" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="601" name="Beach Flags" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6004" agemax="14" agemin="13" name="13-14 ans" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6005" gender="M" number="3" order="3" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="601" name="Beach Flags" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6006" agemax="14" agemin="13" name="13-14 ans" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6007" gender="F" number="4" order="4" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="20" relaycount="1" swimstyleid="602" name="Beach Sprint 90m" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6008" agemax="14" agemin="13" name="13-14 ans" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6009" gender="M" number="5" order="5" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="20" relaycount="1" swimstyleid="602" name="Beach Sprint 90m" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6010" agemax="14" agemin="13" name="13-14 ans" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6011" gender="F" number="6" order="6" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="603" name="Surf Ski 1000m" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6012" agemax="18" agemin="15" name="15-18 ans" />
                <AGEGROUP agegroupid="6022" agemax="-1" agemin="19" name="Open" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6013" gender="M" number="7" order="7" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="603" name="Surf Ski 1000m" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6014" agemax="18" agemin="15" name="15-18 ans" />
                <AGEGROUP agegroupid="6024" agemax="-1" agemin="19" name="Open" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6015" gender="F" number="8" order="8" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="20" relaycount="1" swimstyleid="604" name="Board Rescue 500m" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6016" agemax="18" agemin="15" name="15-18 ans" />
                <AGEGROUP agegroupid="6026" agemax="-1" agemin="19" name="Open" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6017" gender="M" number="9" order="9" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="20" relaycount="1" swimstyleid="604" name="Board Rescue 500m" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6018" agemax="18" agemin="15" name="15-18 ans" />
                <AGEGROUP agegroupid="6028" agemax="-1" agemin="19" name="Open" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6019" number="10" order="10" round="PRE" preveventid="-1">
              <SWIMSTYLE distance="20" relaycount="4" swimstyleid="605" name="Relais Beach Sprint 4x90m" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6020" agemax="18" agemin="15" name="15-18 ans" />
                <AGEGROUP agegroupid="6030" agemax="-1" agemin="19" name="Open" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
        <SESSION date="2026-07-12" daytime="13:00" name="Samedi - Finales" number="2">
          <EVENTS>
            <EVENT eventid="6101" number="11" order="1" round="FIN" preveventid="6001">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="601" name="Beach Flags" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6102" agemax="12" agemin="11" name="11-12 ans" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6103" gender="F" number="12" order="2" round="FIN" preveventid="6003">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="601" name="Beach Flags" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6104" agemax="14" agemin="13" name="13-14 ans" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="6105" gender="M" number="13" order="3" round="FIN" preveventid="6005">
              <SWIMSTYLE distance="16" relaycount="1" swimstyleid="601" name="Beach Flags" stroke="UNKNOWN" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="6106" agemax="14" agemin="13" name="13-14 ans" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>
'''

def main():
    output_path = Path(__file__).parent.parent / "config" / "template_beach.lxf"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("TemplateBeach.lef", TEMPLATE_XML)
    output_path.write_bytes(buf.getvalue())
    print(f"Created {output_path} ({output_path.stat().st_size} bytes)")

if __name__ == "__main__":
    main()