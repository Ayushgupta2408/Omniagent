'use client'
import { useEffect, useRef } from 'react'
import { ActivityEvent, WsMessageType } from '@/types'

interface TypeStyle { color: string; prefix: string }

const TYPE_STYLES: Record<WsMessageType, TypeStyle> = {
  connected:          { color: 'text-green',  prefix: '✓ SYS'  },
  planning:           { color: 'text-cyan',   prefix: '◈  AI'  },
  plan_ready:         { color: 'text-green',  prefix: '✓ PLN'  },
  execution_start:    { color: 'text-cyan',   prefix: '▶ RUN'  },
  step_start:         { color: 'text-ntext',  prefix: '   →'   },
  step_complete:      { color: 'text-green',  prefix: '   ✓'   },
  step_error:         { color: 'text-red',    prefix: '   ✗'   },
  safety_check:       { color: 'text-amber',  prefix: '⚠ SAF' },
  execution_complete: { color: 'text-green',  prefix: '✓ DONE' },
  execution_failed:   { color: 'text-red',    prefix: '✗ FAIL' },
  execution_stopped:  { color: 'text-amber',  prefix: '■ STOP' },
  error:              { color: 'text-red',    prefix: '✗ ERR'  },
}

const FALLBACK: TypeStyle = { color: 'text-muted', prefix: '  ·' }

export default function ActivityLog({ events }: { events: ActivityEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [events])

  return (
    <div className="flex flex-col h-full bg-s1 border border-border rounded-lg overflow-hidden">

      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-s2 flex-shrink-0">
        <span className="text-sm font-600 text-ntext">Activity</span>
        <span className="ml-auto text-xs text-muted">{events.length} events</span>
      </div>

      {/* Events */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        {events.length === 0 ? (
          <div className="text-center text-muted text-xs py-8">
            Waiting for activity...
          </div>
        ) : events.map((ev, i) => {
          const s = TYPE_STYLES[ev.type] ?? FALLBACK
          const isLast = i === events.length - 1
          return (
            <div
              key={i}
              className={`flex gap-2 px-4 py-1.5 text-xs leading-relaxed border-b border-s2 last:border-0 ${isLast ? 'slide-up-anim' : ''}`}
            >
              <span className="text-muted flex-shrink-0 w-12">{ev.time}</span>
              <span className={`flex-shrink-0 font-500 w-12 ${s.color}`}>{s.prefix}</span>
              <span className={`flex-1 break-words ${s.color}`}>
                {ev.message}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
