// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
//
// This file is part of Sauvetage Sportif.
//
// Sauvetage Sportif is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Sauvetage Sportif is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

import { describe, it, expect } from 'vitest'
import { rewritePlaceholders } from '../src/main/pgBackend'

describe('rewritePlaceholders', () => {
  it('rewrites simple ? placeholders positionally', () => {
    expect(rewritePlaceholders('SELECT * FROM t WHERE a=? AND b=?')).toBe(
      'SELECT * FROM t WHERE a=$1 AND b=$2'
    )
  })

  it('does not touch a literal ? inside a string literal', () => {
    expect(rewritePlaceholders(`SELECT COALESCE(a, '???') FROM t`)).toBe(
      `SELECT COALESCE(a, '???') FROM t`
    )
  })

  it('numbers real placeholders correctly around a literal ? string (found via db.ts getHeatListSessions)', () => {
    // Real shape of the bug: a literal '???' fallback string appears in the SELECT list,
    // *before* the real placeholder in the WHERE clause. A naive global replace would
    // consume 3 of the 4 total `?` characters on the literal string (turning it into
    // '$1$2$3') and push the real placeholder to $4 — while only one value is ever bound,
    // leaving $1-$3 (or $4, depending on order) unbound and producing a Postgres error like
    // "could not determine data type of parameter $1".
    const sql = `SELECT COALESCE(name, '???') AS n FROM heat WHERE heatid IN (?) AND lane IS NOT NULL`
    expect(rewritePlaceholders(sql)).toBe(
      `SELECT COALESCE(name, '???') AS n FROM heat WHERE heatid IN ($1) AND lane IS NOT NULL`
    )
  })

  it('handles an escaped quote (\'\') inside a string containing a ?', () => {
    expect(rewritePlaceholders(`SELECT * FROM t WHERE name='it''s a ?' AND id=?`)).toBe(
      `SELECT * FROM t WHERE name='it''s a ?' AND id=$1`
    )
  })

  it('handles multiple string literals interleaved with real placeholders', () => {
    expect(rewritePlaceholders(`INSERT INTO t (a, b, c) VALUES (?, '??', ?)`)).toBe(
      `INSERT INTO t (a, b, c) VALUES ($1, '??', $2)`
    )
  })
})
