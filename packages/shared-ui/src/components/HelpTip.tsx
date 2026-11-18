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

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

const BUBBLE_WIDTH = 288 // px (w-72)
const GUTTER = 8

/**
 * Help bubble: a small "?" button that opens a styled explanation.
 *
 * Opens on hover (desktop) or tap/click (tablets — a native `title` tooltip
 * never shows there), stays open while the pointer is on the button or the
 * bubble, and closes on Escape or a click elsewhere. The bubble is
 * `position: fixed`, placed from the button's rect, so a card's
 * `overflow: hidden` can't clip it.
 */
export default function HelpTip({ children, label = '?', ariaLabel }: {
  children: ReactNode
  label?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.min(
      Math.max(GUTTER, r.right - BUBBLE_WIDTH),
      window.innerWidth - BUBBLE_WIDTH - GUTTER,
    )
    // Below the button unless it sits in the bottom third of the window.
    const above = r.bottom > window.innerHeight * 0.66
    setPos({ top: above ? r.top - 6 : r.bottom + 6, left: Math.max(GUTTER, left), above })
  }, [])

  const show = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    place()
    setOpen(true)
  }, [place])

  const hideSoon = useCallback(() => {
    if (pinned) return
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }, [pinned])

  const close = useCallback(() => { setOpen(false); setPinned(false) }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node
      if (buttonRef.current?.contains(t) || bubbleRef.current?.contains(t)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('touchstart', onDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onClick={(e) => {
          e.preventDefault() // inside a <label>: don't focus the field
          if (open && pinned) { close() } else { show(); setPinned(true) }
        }}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-blue-400 text-blue-600 bg-white text-[10px] font-bold leading-none hover:bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400 shrink-0"
      >
        {label}
      </button>
      {open && pos && (
        <div
          ref={bubbleRef}
          id={id}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hideSoon}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: BUBBLE_WIDTH,
            transform: pos.above ? 'translateY(-100%)' : undefined,
          }}
          className="z-50 rounded-md border border-gray-200 bg-white p-3 text-xs font-normal text-gray-700 shadow-lg normal-case text-left space-y-2"
        >
          {children}
        </div>
      )}
    </>
  )
}
