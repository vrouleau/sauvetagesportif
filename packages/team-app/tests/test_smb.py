"""Test SMB/gbin parsing against a real Splash Meet Manager backup."""

import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.smb import read_smb, read_smb_with_cols, encode_gbin, decode_gbin


SMB_FILE = Path(r"C:\Users\eoivnru\Downloads\CQS Piscine mai 2026 avec résultats - CSSG.smb")


def test_read_smb():
    """Verify all tables parse with correct record counts."""
    if not SMB_FILE.exists():
        print(f"SKIP: {SMB_FILE} not found")
        return

    tables = read_smb(SMB_FILE)

    expected = {
        "BSGLOBAL": 38,
        "SWIMSTYLE": 91,
        "SWIMSESSION": 5,
        "CLUB": 15,
        "ATHLETE": 128,
        "SWIMEVENT": 83,
        "AGEGROUP": 89,
        "HEAT": 191,
        "SWIMRESULT": 1010,
        "SPLIT": 1140,
        "RELAY": 93,
        "RELAYPOSITION": 276,
        "RELAYSPLIT": 99,
        "RESULTPLACE": 1074,
    }

    print("Table record counts:")
    all_ok = True
    for tname, expected_count in expected.items():
        actual = len(tables.get(tname, []))
        status = "✓" if actual == expected_count else "✗"
        if actual != expected_count:
            all_ok = False
        print(f"  {status} {tname}: {actual}/{expected_count}")

    assert all_ok, "Some tables have wrong record counts"


def test_swimsession_values():
    """Verify specific field values for SWIMSESSION."""
    if not SMB_FILE.exists():
        print(f"SKIP: {SMB_FILE} not found")
        return

    tables = read_smb(SMB_FILE)
    sessions = tables["SWIMSESSION"]

    # Find session 1058
    s1 = next(s for s in sessions if s["swimsessionid"] == 1058)
    assert s1["name"] == "Samedi Seniors - Préliminaires"
    assert s1["feeathlete"] == 65.0
    assert s1["sessionnumber"] == 2
    assert s1["course"] == 1
    assert s1["lanemin"] == 1
    assert s1["lanemax"] == 8
    assert s1["maxentriesathlete"] is None
    assert s1["maxentriesrelay"] is None
    print("  ✓ Session 1058 values correct")

    # Session 1321 has null fee
    s5 = next(s for s in sessions if s["swimsessionid"] == 1321)
    assert s5["name"] == "Dimanche Seniors - Finales"
    assert s5["feeathlete"] is None
    assert s5["sessionnumber"] == 6
    print("  ✓ Session 1321 null fee correct")


def test_roundtrip():
    """Verify encode→decode roundtrip preserves data."""
    if not SMB_FILE.exists():
        print(f"SKIP: {SMB_FILE} not found")
        return

    tables = read_smb_with_cols(SMB_FILE)

    # Roundtrip SWIMSTYLE
    cols, rows = tables["SWIMSTYLE"]
    encoded = encode_gbin(cols, rows)
    cols2, rows2 = decode_gbin(encoded)

    assert len(rows2) == len(rows), f"SWIMSTYLE roundtrip: {len(rows2)} != {len(rows)}"

    # Check first row values match
    for key in rows[0]:
        assert rows[0][key] == rows2[0][key], f"SWIMSTYLE[0].{key}: {rows[0][key]} != {rows2[0][key]}"
    print(f"  ✓ SWIMSTYLE roundtrip: {len(rows)} records")

    # Roundtrip SWIMSESSION
    cols, rows = tables["SWIMSESSION"]
    encoded = encode_gbin(cols, rows)
    cols2, rows2 = decode_gbin(encoded)
    assert len(rows2) == len(rows), f"SWIMSESSION roundtrip: {len(rows2)} != {len(rows)}"
    print(f"  ✓ SWIMSESSION roundtrip: {len(rows)} records")

    # Roundtrip SPLIT
    cols, rows = tables["SPLIT"]
    encoded = encode_gbin(cols, rows)
    cols2, rows2 = decode_gbin(encoded)
    assert len(rows2) == len(rows), f"SPLIT roundtrip: {len(rows2)} != {len(rows)}"
    print(f"  ✓ SPLIT roundtrip: {len(rows)} records")


if __name__ == "__main__":
    print("=== test_read_smb ===")
    test_read_smb()
    print("\n=== test_swimsession_values ===")
    test_swimsession_values()
    print("\n=== test_roundtrip ===")
    test_roundtrip()
    print("\n✓ All tests passed!")
