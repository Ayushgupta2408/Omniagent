'use client'
import { useState, useRef, KeyboardEvent } from 'react'

const EXAMPLES = [
  "Open Chrome and search for the latest AI news",
  "Create a folder called 'Projects' and make a Python hello world file",
  "Open Notepad and type a motivational quote",
  "Search YouTube for lofi hip hop music",
  "Create a React component file for a login form",
  "Open Spotify and search for jazz playlist",
]

interface PromptInputProps {
  onSubmit: (prompt: string) => void
  loading: boolean
}

export default function PromptInput({ onSubmit, loading }: PromptInputProps) {
  const [prompt, setPrompt]   = useState('')
  const [focused, setFocused] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => { if (prompt.trim() && !loading) onSubmit(prompt.trim()) }
  const onKey  = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Input */}
      <div className="relative">
        <textarea
          ref={ref}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Describe what you want to automate..."
          disabled={loading}
          rows={3}
          className={`w-full bg-black rounded-lg px-4 py-3
            text-ntext font-sans text-[14px] leading-relaxed resize-none outline-none
            transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed
            placeholder:text-dim border
            ${focused
              ? 'border-cyan shadow-[0_0_0_2px_rgba(0,102,204,0.1)]'
              : 'border-border'
            }`}
        />
      </div>

      {/* Submit */}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={!prompt.trim() || loading}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-500 transition-all duration-200
            disabled:cursor-not-allowed disabled:opacity-50
            ${prompt.trim() && !loading
              ? 'bg-cyan text-white hover:bg-cyan/90'
              : 'bg-s2 text-muted'
            }`}
        >
          {loading ? (
            <>
              <svg className="spin-fast" width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="12 24" strokeLinecap="round"/>
              </svg>
              <span>Generating...</span>
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M2 8H14M14 8L10 4M14 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span>Generate Plan</span>
            </>
          )}
        </button>
      </div>

      {/* Examples */}
      <div className="flex flex-col gap-2">
        <div className="text-xs text-muted font-500">
          Example tasks:
        </div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex, i) => (
            <button
              key={i}
              onClick={() => { setPrompt(ex); ref.current?.focus() }}
              disabled={loading}
              className="text-xs px-3 py-1.5 bg-s2 border border-border
                rounded-md text-muted transition-all duration-150
                hover:text-cyan hover:border-cyan disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {ex.length > 30 ? ex.slice(0, 27) + '...' : ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
