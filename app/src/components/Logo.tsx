/**
 * OpenPendle brand mark + wordmark. The mark is the "open-door P" (a cut-away
 * ring opening onto a ball-terminal stem), indigo→violet gradient. The wordmark
 * is "Open" in the theme foreground + "Pendle" in the brand gradient. Links home.
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'

/** The brand symbol — a self-contained gradient SVG (viewBox 0 0 64 64). */
export function BrandMark({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="OpenPendle"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="13" y1="9" x2="51" y2="55">
          <stop offset="0" stopColor="#A78BFA" />
          <stop offset=".52" stopColor="#7A6BF4" />
          <stop offset="1" stopColor="#5A63E8" />
        </linearGradient>
      </defs>
      <path
        d="M13.64 23.74 A18.5 18.5 0 1 1 17.23 37.13 L22.82 32.92 A11.5 11.5 0 1 0 20.59 24.60 Z"
        fill={`url(#${id})`}
      />
      <path d="M28.6 15 L35.5 15 L35.5 57 L28.6 52 Z" fill={`url(#${id})`} />
      <circle cx="32" cy="15.5" r="4.9" fill={`url(#${id})`} />
    </svg>
  )
}

export function Logo() {
  return (
    <Link to="/" className="flex flex-shrink-0 items-center gap-[9px] no-underline">
      <BrandMark className="h-[26px] w-[26px]" />
      <span className="hidden text-[17.5px] font-extrabold tracking-[-.035em] text-fg sm:inline">
        Open
        <span
          className="bg-clip-text text-transparent"
          style={{ backgroundImage: 'linear-gradient(135deg,#A78BFA,#6366F1)' }}
        >
          Pendle
        </span>
      </span>
    </Link>
  )
}
