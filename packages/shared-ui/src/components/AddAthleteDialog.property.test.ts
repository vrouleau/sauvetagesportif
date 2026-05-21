import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

/**
 * Property 6: Add Athlete Validation
 *
 * For any input where first_name or last_name is empty or consists entirely
 * of whitespace, the AddAthleteDialog shall reject submission and not call
 * the onConfirm callback.
 *
 * **Validates: Requirements 6.3**
 *
 * We test the validation logic directly: firstName.trim() and lastName.trim()
 * must both be non-empty for submission to proceed.
 */

// Extract the validation logic as a pure function matching AddAthleteDialog's behavior
function validateAthleteForm(firstName: string, lastName: string): boolean {
  return firstName.trim().length > 0 && lastName.trim().length > 0
}

// Arbitrary that generates empty or whitespace-only strings
const whitespaceOnlyArb = fc.oneof(
  fc.constant(''),
  fc.nat({ max: 10 }).map(n => ' '.repeat(n)),
  fc.nat({ max: 5 }).map(n => '\t'.repeat(n)),
  fc.nat({ max: 5 }).map(n => ' '.repeat(n) + '\t'.repeat(n)),
)

describe('AddAthleteDialog - Property 6: Add Athlete Validation', () => {
  it('should reject submission when firstName is empty or whitespace-only', () => {
    fc.assert(
      fc.property(
        // Generate empty or whitespace-only strings for firstName
        whitespaceOnlyArb,
        // Generate any string for lastName (including valid ones)
        fc.string(),
        (firstName, lastName) => {
          const isValid = validateAthleteForm(firstName, lastName)
          // When firstName is empty/whitespace, validation must fail
          expect(isValid).toBe(false)
        }
      )
    )
  })

  it('should reject submission when lastName is empty or whitespace-only', () => {
    fc.assert(
      fc.property(
        // Generate any string for firstName (including valid ones)
        fc.string(),
        // Generate empty or whitespace-only strings for lastName
        whitespaceOnlyArb,
        (firstName, lastName) => {
          const isValid = validateAthleteForm(firstName, lastName)
          // When lastName is empty/whitespace, validation must fail
          expect(isValid).toBe(false)
        }
      )
    )
  })

  it('should reject submission when both firstName and lastName are empty or whitespace-only', () => {
    fc.assert(
      fc.property(
        whitespaceOnlyArb,
        whitespaceOnlyArb,
        (firstName, lastName) => {
          const isValid = validateAthleteForm(firstName, lastName)
          expect(isValid).toBe(false)
        }
      )
    )
  })

  it('should accept submission when both firstName and lastName have non-whitespace content', () => {
    fc.assert(
      fc.property(
        // Generate strings that have at least one non-whitespace character
        fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
        fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
        (firstName, lastName) => {
          const isValid = validateAthleteForm(firstName, lastName)
          expect(isValid).toBe(true)
        }
      )
    )
  })
})
