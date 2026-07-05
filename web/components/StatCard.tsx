'use client'

interface StatCardProps {
  label: string
  value: string
  color: string
}

export default function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className="bg-s1 border border-border rounded-lg p-3">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className={`text-lg font-600 ${color}`}>{value}</div>
    </div>
  )
}
