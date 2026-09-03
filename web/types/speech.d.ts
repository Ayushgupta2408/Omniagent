/**
 * types/speech.d.ts
 *
 * Minimal ambient typings for the Web Speech API's SpeechRecognition
 * interface. TypeScript's built-in DOM lib does not ship these yet,
 * so we declare just enough surface for useVoiceRecognition.ts.
 *
 * Location: web/types/speech.d.ts
 */

export {}

declare global {
  interface SpeechRecognitionAlternative {
    transcript: string
    confidence: number
  }

  interface SpeechRecognitionResult {
    isFinal: boolean
    length: number
    [index: number]: SpeechRecognitionAlternative
  }

  interface SpeechRecognitionResultList {
    length: number
    [index: number]: SpeechRecognitionResult
  }

  interface SpeechRecognitionEvent extends Event {
    resultIndex: number
    results: SpeechRecognitionResultList
  }

  interface SpeechRecognitionErrorEvent extends Event {
    error: string
    message: string
  }

  interface SpeechRecognition extends EventTarget {
    continuous: boolean
    interimResults: boolean
    lang: string
    maxAlternatives: number

    start(): void
    stop(): void
    abort(): void

    onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null
    onend: ((this: SpeechRecognition, ev: Event) => unknown) | null
    onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null
    onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown) | null
  }

  interface Window {
    SpeechRecognition?: { new (): SpeechRecognition }
    webkitSpeechRecognition?: { new (): SpeechRecognition }
  }
}