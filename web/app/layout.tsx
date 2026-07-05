import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OmniAgent — AI Automation Agent',
  description: 'Intelligent local automation powered by AI',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="ambient-bg min-h-screen">
        <div className="scan-line" />
        {children}
      </body>
    </html>
  )
}