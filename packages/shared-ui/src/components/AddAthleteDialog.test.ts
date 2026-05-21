import { describe, it, expect } from 'vitest'
import type { NewAthleteData } from './AddAthleteDialog'

/**
 * Unit tests for AddAthleteDialog validation logic.
 * Tests the validation rules: first_name and last_name must be non-empty/non-whitespace.
 */

function validateNewAthlete(data: Partial<NewAthleteData>): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!data.first_name || !data.first_name.trim()) {
    errors.push('first_name')
  }
  if (!data.last_name || !data.last_name.trim()) {
    errors.push('last_name')
  }
  return { valid: errors.length === 0, errors }
}

describe('AddAthleteDialog validation', () => {
  it('rejects empty first name', () => {
    const result = validateNewAthlete({ first_name: '', last_name: 'Doe', gender: 'M', license: '', club_id: 1 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('first_name')
  })

  it('rejects whitespace-only first name', () => {
    const result = validateNewAthlete({ first_name: '   ', last_name: 'Doe', gender: 'M', license: '', club_id: 1 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('first_name')
  })

  it('rejects empty last name', () => {
    const result = validateNewAthlete({ first_name: 'John', last_name: '', gender: 'M', license: '', club_id: 1 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('last_name')
  })

  it('rejects whitespace-only last name', () => {
    const result = validateNewAthlete({ first_name: 'John', last_name: '  \t  ', gender: 'M', license: '', club_id: 1 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('last_name')
  })

  it('rejects both empty first and last name', () => {
    const result = validateNewAthlete({ first_name: '', last_name: '', gender: 'M', license: '', club_id: 1 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('first_name')
    expect(result.errors).toContain('last_name')
  })

  it('accepts valid first and last name', () => {
    const result = validateNewAthlete({ first_name: 'John', last_name: 'Doe', gender: 'M', license: '12345', club_id: 1 })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts names with leading/trailing spaces (trimmed)', () => {
    const result = validateNewAthlete({ first_name: ' Alice ', last_name: ' Smith ', gender: 'F', license: '', club_id: 2 })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('allows empty license (optional field)', () => {
    const result = validateNewAthlete({ first_name: 'Bob', last_name: 'Martin', gender: 'M', license: '', club_id: 1 })
    expect(result.valid).toBe(true)
  })

  it('allows null birthdate (optional field)', () => {
    const result = validateNewAthlete({ first_name: 'Bob', last_name: 'Martin', gender: 'M', birthdate: null, license: '', club_id: 1 })
    expect(result.valid).toBe(true)
  })
})
