import { describe, it, expect } from 'vitest'
import { filterAthletes, computeVisibleExpansion } from './filterAthletes'
import type { AthleteListItem } from '../data/api'

function makeAthlete(id: number, first: string, last: string): AthleteListItem {
  return { id, first_name: first, last_name: last, gender: 'M', birthdate: '2000-01-01', license: '' }
}

describe('filterAthletes', () => {
  const club1Athletes: AthleteListItem[] = [
    makeAthlete(1, 'Jean', 'Dupont'),
    makeAthlete(2, 'Marie', 'Tremblay'),
  ]
  const club2Athletes: AthleteListItem[] = [
    makeAthlete(3, 'Pierre', 'Dumont'),
    makeAthlete(4, 'Sophie', 'Dupont'),
  ]

  const athletesByClub = new Map<number, AthleteListItem[]>([
    [10, club1Athletes],
    [20, club2Athletes],
  ])

  it('returns all athletes and empty autoExpandClubs when filterText is empty', () => {
    const result = filterAthletes(athletesByClub, '')
    expect(result.filtered).toBe(athletesByClub)
    expect(result.autoExpandClubs.size).toBe(0)
  })

  it('filters athletes by case-insensitive substring match on full name', () => {
    const result = filterAthletes(athletesByClub, 'dupont')
    expect(result.filtered.get(10)!.map((a) => a.id)).toEqual([1])
    expect(result.filtered.get(20)!.map((a) => a.id)).toEqual([4])
  })

  it('auto-expands clubs that have matching athletes', () => {
    const result = filterAthletes(athletesByClub, 'dupont')
    expect(result.autoExpandClubs.has(10)).toBe(true)
    expect(result.autoExpandClubs.has(20)).toBe(true)
  })

  it('excludes clubs with no matching athletes', () => {
    const result = filterAthletes(athletesByClub, 'tremblay')
    expect(result.filtered.has(10)).toBe(true)
    expect(result.filtered.has(20)).toBe(false)
    expect(result.autoExpandClubs.has(20)).toBe(false)
  })

  it('returns empty map when no athletes match', () => {
    const result = filterAthletes(athletesByClub, 'xyz')
    expect(result.filtered.size).toBe(0)
    expect(result.autoExpandClubs.size).toBe(0)
  })

  it('matches on first_name + space + last_name combined', () => {
    const result = filterAthletes(athletesByClub, 'jean du')
    expect(result.filtered.get(10)!.map((a) => a.id)).toEqual([1])
  })

  it('is case-insensitive', () => {
    const result = filterAthletes(athletesByClub, 'MARIE')
    expect(result.filtered.get(10)!.map((a) => a.id)).toEqual([2])
  })
})

describe('computeVisibleExpansion', () => {
  const manualExpanded = new Set([10, 30])
  const autoExpanded = new Set([20, 40])

  it('returns autoExpandClubs when filter is active', () => {
    const result = computeVisibleExpansion(manualExpanded, autoExpanded, 'some filter')
    expect(result).toBe(autoExpanded)
  })

  it('returns manual expandedClubs when no filter is active', () => {
    const result = computeVisibleExpansion(manualExpanded, autoExpanded, '')
    expect(result).toBe(manualExpanded)
  })
})
