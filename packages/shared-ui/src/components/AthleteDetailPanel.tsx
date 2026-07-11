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

import { useState, useEffect } from 'react'
import type { RegistrationData, Club } from '../data/api'
import { useLang } from '../context/LangContext'

export interface AthleteDetailPanelProps {
  athlete: RegistrationData['athlete'] | null
  athleteId: number
  onSave: (field: string, value: string) => void
  /** Full club list, needed to render the club picker. Only required when canChangeClub is true. */
  clubs?: Club[]
  /** Whether the current user is allowed to move this athlete to a different club (admin-only). */
  canChangeClub?: boolean
}

/**
 * Displays and allows inline editing of the selected athlete's personal information.
 * Uses blur-to-save pattern: edits are saved when the field loses focus.
 * Shows an empty state when no athlete is selected.
 */
export default function AthleteDetailPanel({ athlete, athleteId, onSave, clubs, canChangeClub }: AthleteDetailPanelProps) {
  const { t } = useLang()
  const tr = t.registration

  if (!athlete) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-xs italic">
        {tr.noAthleteSelected}
      </div>
    )
  }

  return (
    <div className="px-3 py-2 bg-white border-b border-gray-300">
      <div className="flex items-center gap-3 flex-wrap">
        <EditableField
          key={`${athleteId}-last_name`}
          label={tr.lastName}
          defaultValue={athlete.last_name}
          onSave={(value) => onSave('last_name', value)}
        />
        <EditableField
          key={`${athleteId}-first_name`}
          label={tr.firstName}
          defaultValue={athlete.first_name}
          onSave={(value) => onSave('first_name', value)}
        />
        <GenderField
          key={`${athleteId}-gender`}
          label={tr.gender}
          defaultValue={athlete.gender}
          onSave={(value) => onSave('gender', value)}
        />
        <DateField
          key={`${athleteId}-birthdate`}
          label={tr.dob}
          defaultValue={athlete.birthdate}
          onSave={(value) => onSave('birthdate', value)}
        />
        <EditableField
          key={`${athleteId}-license`}
          label={tr.nran}
          defaultValue={athlete.license}
          onSave={(value) => onSave('license', value)}
          width="w-20"
        />
        <ExceptionCheckbox
          key={`${athleteId}-handicapex`}
          label={tr.exception}
          checked={athlete.handicapex === 'X'}
          onSave={(checked) => onSave('handicapex', checked ? 'X' : '')}
        />
        {canChangeClub && clubs ? (
          <ClubField
            key={`${athleteId}-club`}
            label={tr.club}
            defaultValue={athlete.club_id ?? ''}
            clubs={clubs}
            onSave={(value) => onSave('club_id', value)}
          />
        ) : (
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-500">{tr.club}:</label>
            <span className="text-xs text-gray-600">{athlete.club}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** Inline text input with blur-to-save */
function EditableField({
  label,
  defaultValue,
  onSave,
  width = 'w-28',
}: {
  label: string
  defaultValue: string
  onSave: (value: string) => void
  width?: string
}) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    setValue(defaultValue)
  }, [defaultValue])

  function handleBlur() {
    if (value !== defaultValue) {
      onSave(value)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <label className="text-xs text-gray-500">{label}:</label>
      <input
        className={`border border-gray-300 px-1.5 py-0.5 rounded text-xs ${width}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        onBlur={handleBlur}
      />
    </div>
  )
}

/** Gender select with change-to-save */
function GenderField({
  label,
  defaultValue,
  onSave,
}: {
  label: string
  defaultValue: string
  onSave: (value: string) => void
}) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    setValue(defaultValue)
  }, [defaultValue])

  function handleChange(newValue: string) {
    setValue(newValue)
    if (newValue !== defaultValue) {
      onSave(newValue)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <label className="text-xs text-gray-500">{label}:</label>
      <select
        className="border border-gray-300 px-1 py-0.5 rounded text-xs"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
      >
        <option value="M">M</option>
        <option value="F">F</option>
      </select>
    </div>
  )
}

/** Club select with change-to-save (admin-only: reassigns the athlete to a different club) */
function ClubField({
  label,
  defaultValue,
  clubs,
  onSave,
}: {
  label: string
  defaultValue: number | ''
  clubs: Club[]
  onSave: (value: string) => void
}) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    setValue(defaultValue)
  }, [defaultValue])

  function handleChange(newValue: string) {
    setValue(Number(newValue))
    if (Number(newValue) !== defaultValue) {
      onSave(newValue)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <label className="text-xs text-gray-500">{label}:</label>
      <select
        className="border border-gray-300 px-1 py-0.5 rounded text-xs"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
      >
        {clubs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  )
}

/** Date input with blur-to-save */
function DateField({
  label,
  defaultValue,
  onSave,
}: {
  label: string
  defaultValue: string
  onSave: (value: string) => void
}) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    setValue(defaultValue)
  }, [defaultValue])

  function handleBlur() {
    if (value !== defaultValue) {
      onSave(value)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <label className="text-xs text-gray-500">{label}:</label>
      <input
        type="date"
        className="border border-gray-300 px-1.5 py-0.5 rounded text-xs"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        onBlur={handleBlur}
      />
    </div>
  )
}

/** Checkbox for exception code (X or empty) */
function ExceptionCheckbox({
  label,
  checked,
  onSave,
}: {
  label: string
  checked: boolean
  onSave: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-1">
      <label className="text-xs text-gray-500">{label}:</label>
      <input
        type="checkbox"
        className="h-3.5 w-3.5"
        checked={checked}
        onChange={(e) => onSave(e.target.checked)}
      />
    </div>
  )
}