'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { WsMessage } from '@/types'

type Listener = (data: WsMessage) => void

export function useWebSocket(url: string) {
  const wsRef             = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null)
  const listenersRef      = useRef<Map<symbol, Listener>>(new Map())
  const reconnectTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef        = useRef(false)

  const connect = useCallback(() => {
    // Don't open a second socket if one already exists and is open/connecting
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return

    try {
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        console.log('[WS] Connected')
      }

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data) as WsMessage
          setLastMessage(data)
          // Iterate over a snapshot so unsubscribes during dispatch are safe
          for (const fn of Array.from(listenersRef.current.values())) {
            fn(data)
          }
        } catch (e) {
          console.error('[WS] Parse error', e)
        }
      }

      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        console.log('[WS] Disconnected, reconnecting in 3s...')
        reconnectTimer.current = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        console.error('[WS] Error — closing socket')
        ws.close()
      }
    } catch (e) {
      console.error('[WS] Connection failed', e)
      reconnectTimer.current = setTimeout(connect, 3000)
    }
  }, [url])

  useEffect(() => {
    // Guard against React StrictMode double-invoke
    if (mountedRef.current) return
    mountedRef.current = true

    connect()

    return () => {
      mountedRef.current = false
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [connect])

  /**
   * Register a listener. Returns an unsubscribe function.
   * Uses a Symbol key so each call gets a unique slot — no accidental dedup
   * of two different handlers that happen to be the same function reference.
   */
  const subscribe = useCallback((fn: Listener): (() => void) => {
    const key = Symbol()
    listenersRef.current.set(key, fn)
    return () => { listenersRef.current.delete(key) }
  }, [])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { connected, lastMessage, subscribe, send }
}