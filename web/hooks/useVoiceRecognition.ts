'use client'

/**
 * hooks/useVoiceRecognition.ts
 *
 * Wraps the browser's native Web Speech API (SpeechRecognition) so
 * components can turn voice into text without touching the DOM API
 * directly. Fully client-side — no server round trip, no new backend
 * endpoint required, since transcribed text is just handed to the
 * existing prompt pipeline.
 *
 * Location: web/hooks/useVoiceRecognition.ts
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseVoiceRecognitionOptions {
  /** Called on every recognition update. `isFinal` marks a completed phrase. */
  onResult?: (transcript: string, isFinal: boolean) => void
  /** Called when the browser reports a recognition error (e.g. mic denied). */
  onError?: (error: string) => void
  /** BCP-47 language tag. Defaults to the browser's language. */
  lang?: string
}

interface UseVoiceRecognitionReturn {
  listening: boolean
  supported: boolean
  interimTranscript: string
  start: () => void
  stop: () => void
  toggle: () => void
}

export function useVoiceRecognition({
  onResult,
  onError,
  lang,
}: UseVoiceRecognitionOptions = {}): UseVoiceRecognitionReturn {
  const [listening, setListening] = useState(false)
  const [supported, setSupported] = useState(false)
  const [interimTranscript, setInterimTranscript] = useState('')

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const onResultRef = useRef(onResult)
  const onErrorRef = useRef(onError)

  // Keep latest callbacks without re-creating the recognition instance.
  useEffect(() => { onResultRef.current = onResult }, [onResult])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  useEffect(() => {
    const SpeechRecognitionCtor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition

    if (!SpeechRecognitionCtor) {
      setSupported(false)
      return
    }
    setSupported(true)

    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = lang ?? navigator.language ?? 'en-US'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) final += text
        else interim += text
      }

      if (interim) {
        setInterimTranscript(interim)
        onResultRef.current?.(interim, false)
      }
      if (final) {
        setInterimTranscript('')
        onResultRef.current?.(final.trim(), true)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      onErrorRef.current?.(event.error)
      setListening(false)
    }

    recognition.onend = () => setListening(false)

    recognitionRef.current = recognition

    return () => {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.abort()
      recognitionRef.current = null
    }
  }, [lang])

  const start = useCallback(() => {
    if (!recognitionRef.current || listening) return
    try {
      recognitionRef.current.start()
      setListening(true)
    } catch {
      // start() throws if recognition is already active — ignore.
    }
  }, [listening])

  const stop = useCallback(() => {
    if (!recognitionRef.current) return
    recognitionRef.current.stop()
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  return { listening, supported, interimTranscript, start, stop, toggle }
}