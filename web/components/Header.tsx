'use client'

interface HeaderProps {
  connected: boolean
}

export default function Header({ connected }: HeaderProps) {
  return (
    <header className="border-b border-border bg-s1 sticky top-0 z-50 flex-shrink-0">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">

        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="relative w-8 h-8 rounded-md bg-cyan flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
              <path d="M9 1L16 5V13L9 17L2 13V5L9 1Z" stroke="#ffffff" strokeWidth="1.3" fill="none"/>
              <circle cx="9" cy="9" r="2" fill="#ffffff"/>
            </svg>
          </div>

          <div>
            <div className="font-display text-[18px] font-600 text-ntext leading-none">
              OmniAgent
            </div>
          </div>
        </div>

        {/* Connection status */}
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium
          ${connected
            ? 'text-green bg-green/10 border border-green/30'
            : 'text-muted bg-s2 border border-border'
          }`}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green' : 'bg-dim'}`} />
          {connected ? 'Connected' : 'Offline'}
        </div>
      </div>
    </header>
  )
}
