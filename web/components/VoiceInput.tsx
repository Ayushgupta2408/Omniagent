'use client'

/**
 * components/VoiceInput.tsx
 *
 * Mic button that turns speech into text using useVoiceRecognition.
 * Streams interim words live via onTranscript, and reports a finished
 * phrase via onFinalTranscript so the caller can decide whether to
 * auto-submit or let the user review/edit first.
 *
 * Location: web/components/VoiceInput.tsx
 */

import { useCallback, useState } from 'react'
import { useVoiceRecognition } from '@/hooks/useVoiceRecognition'

interface VoiceInputProps {
  onTranscript: (text: string) => void
  onFinalTranscript?: (text: string) => void
  disabled?: boolean
}

export default function VoiceInput({ onTranscript, onFinalTranscript, disabled }: VoiceInputProps) {
  const [voiceError, setVoiceError] = useState<string | null>(null)

  const handleResult = useCallback(
    (transcript: string, isFinal: boolean) => {
      setVoiceError(null)
      onTranscript(transcript)
      if (isFinal) onFinalTranscript?.(transcript)
    },
    [onTranscript, onFinalTranscript]
  )

  const handleError = useCallback((err: string) => {
    setVoiceError(
      err === 'not-allowed' || err === 'permission-denied'
        ? 'Mic access denied'
        : err === 'no-speech'
          ? "Didn't catch that"
          : 'Voice input error'
    )
  }, [])

  const { listening, supported, toggle } = useVoiceRecognition({
    onResult: handleResult,
    onError: handleError,
  })

  if (!supported) return null

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={listening ? 'Stop voice command' : 'Speak a command'}
        aria-pressed={listening}
        aria-label={listening ? 'Stop listening' : 'Start voice command'}
        className={`relative flex items-center justify-center w-9 h-9 rounded-lg border
          transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50
          ${listening
            ? 'bg-red/10 border-red text-red'
            : 'bg-s2 border-border text-muted hover:text-cyan hover:border-cyan'
          }`}
      >
        {listening && (
          <span className="absolute inset-0 rounded-lg border border-red pulse-ring-anim" />
        )}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <rect x="6" y="1.5" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.5 7.5v.5a4.5 4.5 0 0 0 9 0v-.5M8 12.5v2M6 14.5h4"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>

      {listening && (
        <span className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 text-[10px]
          text-red whitespace-nowrap font-500 tracking-wide">
          LISTENING
        </span>
      )}

      {voiceError && !listening && (
        <span className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 text-[10px]
          text-amber whitespace-nowrap">
          {voiceError}
        </span>
      )}
    </div>
  )
}