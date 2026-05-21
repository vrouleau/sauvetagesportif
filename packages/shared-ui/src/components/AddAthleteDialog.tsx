import { useState, type FormEvent } from 'react'
import { useLang } from '../context/LangContext'

export interface NewAthleteData {
  first_name: string
  last_name: string
  gender: string
  birthdate: string | null
  license: string
  club_id: number
}

export interface AddAthleteDialogProps {
  clubId: number
  clubName: string
  onConfirm: (data: NewAthleteData) => void
  onCancel: () => void
}

export default function AddAthleteDialog({
  clubId,
  clubName,
  onConfirm,
  onCancel,
}: AddAthleteDialogProps) {
  const { t } = useLang()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [gender, setGender] = useState('M')
  const [birthdate, setBirthdate] = useState('')
  const [license, setLicense] = useState('')
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string }>({})

  function validate(): boolean {
    const newErrors: { firstName?: string; lastName?: string } = {}
    if (!firstName.trim()) {
      newErrors.firstName = t.registration.firstName
    }
    if (!lastName.trim()) {
      newErrors.lastName = t.registration.lastName
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!validate()) return
    onConfirm({
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      gender,
      birthdate: birthdate || null,
      license: license.trim(),
      club_id: clubId,
    })
  }

  const Field = ({
    label,
    value,
    onChange,
    error,
    type = 'text',
    required = false,
  }: {
    label: string
    value: string
    onChange: (v: string) => void
    error?: string
    type?: string
    required?: boolean
  }) => (
    <div className="flex items-center gap-3 mb-2">
      <label className="w-28 text-right text-gray-600 text-xs shrink-0">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <div className="flex-1">
        <input
          type={type}
          className={`w-full border px-2 py-1 text-xs bg-white ${
            error ? 'border-red-400' : 'border-gray-300'
          }`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {error && (
          <span className="text-red-500 text-[10px]">{error}</span>
        )}
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[420px] text-xs">
        {/* Header - matches DbConfigDialog pattern */}
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
          <span className="font-semibold">{t.registration.addAthlete}</span>
          <button onClick={onCancel} className="hover:text-gray-300 text-lg leading-none">×</button>
        </div>

        {/* Form body */}
        <form onSubmit={handleSubmit}>
          <div className="p-5">
            {/* Club name (read-only info) */}
            <div className="flex items-center gap-3 mb-3">
              <label className="w-28 text-right text-gray-600 text-xs shrink-0">
                {t.athletes.dialog.club}
              </label>
              <span className="text-xs font-medium text-gray-800">{clubName}</span>
            </div>

            <Field
              label={t.registration.lastName}
              value={lastName}
              onChange={(v) => { setLastName(v); setErrors((e) => ({ ...e, lastName: undefined })) }}
              error={errors.lastName}
              required
            />
            <Field
              label={t.registration.firstName}
              value={firstName}
              onChange={(v) => { setFirstName(v); setErrors((e) => ({ ...e, firstName: undefined })) }}
              error={errors.firstName}
              required
            />

            {/* Gender select */}
            <div className="flex items-center gap-3 mb-2">
              <label className="w-28 text-right text-gray-600 text-xs shrink-0">
                {t.registration.gender}
              </label>
              <select
                className="flex-1 border border-gray-300 px-2 py-1 text-xs bg-white"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
              >
                <option value="M">{t.athletes.dialog.genderM}</option>
                <option value="F">{t.athletes.dialog.genderF}</option>
              </select>
            </div>

            <Field
              label={t.registration.dob}
              value={birthdate}
              onChange={setBirthdate}
              type="date"
            />
            <Field
              label={t.registration.nran}
              value={license}
              onChange={setLicense}
            />
          </div>

          {/* Footer - matches DbConfigDialog pattern */}
          <div className="flex items-center justify-end px-5 py-3 border-t border-gray-200 bg-gray-50 gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
            >
              {t.athletes.dialog.cancel}
            </button>
            <button
              type="submit"
              className="px-4 py-1 bg-blue-600 text-white hover:bg-blue-700 border border-blue-700"
            >
              {t.athletes.dialog.save}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
