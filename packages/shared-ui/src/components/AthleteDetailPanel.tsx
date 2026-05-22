import { useState, useEffect } from 'react'
import type { RegistrationData } from '../data/api'
import { useLang } from '../context/LangContext'

export interface AthleteDetailPanelProps {
  athlete: RegistrationData['athlete'] | null
  athleteId: number
  onSave: (field: string, value: string) => void
}

/**
 * Displays and allows inline editing of the selected athlete's personal information.
 * Uses blur-to-save pattern: edits are saved when the field loses focus.
 * Shows an empty state when no athlete is selected.
 */
export default function AthleteDetailPanel({ athlete, athleteId, onSave }: AthleteDetailPanelProps) {
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
        <div className="flex items-center gap-1">
          <label className="text-xs text-gray-500">{tr.club}:</label>
          <span className="text-xs text-gray-600">{athlete.club}</span>
        </div>
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
