// Crew identity: a stable per-agent colour and a role-derived hat + badge.
// Claude-inspired palette - warm, muted hues.

export interface CrewColor {
  body: string
  dark: string
}

export const CREW_COLORS: CrewColor[] = [
  { body: '#C15F3C', dark: '#8B4028' }, // terracotta
  { body: '#6B8F71', dark: '#47614C' }, // sage
  { body: '#5B7C99', dark: '#3E5871' }, // slate
  { body: '#8B6BA8', dark: '#5F4977' }, // plum
  { body: '#B08B5C', dark: '#7A5E3B' }, // sand
  { body: '#B5697A', dark: '#7D4553' } // rose
]

export type HatKind = 'antenna' | 'visor' | 'beret' | 'cap' | 'headset' | 'crown'

export interface RoleBadge {
  code: string
  color: string
}

export const ROLE_BADGES: Record<HatKind, RoleBadge> = {
  antenna: { code: 'DEV', color: '#6B5B95' },
  visor: { code: 'BE', color: '#5B7C99' },
  beret: { code: 'FE', color: '#47614C' },
  cap: { code: 'OPS', color: '#7D4553' },
  headset: { code: 'QA', color: '#8B6134' },
  crown: { code: 'ORCH', color: '#C15F3C' }
}

function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

export function colorFor(key: string): CrewColor {
  return CREW_COLORS[hash(key) % CREW_COLORS.length]
}

export function hatFor(role: string, isOrchestrator = false): HatKind {
  if (isOrchestrator) return 'crown'
  const r = (role || '').toLowerCase()
  if (r.includes('qa') || r.includes('test')) return 'headset'
  if (r.includes('devops') || r.includes('deploy') || r.includes('infra')) return 'cap'
  if (r.includes('design') || r.includes('frontend') || r.includes('ui')) return 'beret'
  if (r.includes('backend') || r.includes('api') || r.includes('server')) return 'visor'
  return 'antenna'
}

export function badgeFor(role: string, isOrchestrator = false): RoleBadge {
  return ROLE_BADGES[hatFor(role, isOrchestrator)]
}

export function truncate(str: string, n: number): string {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

export function formatAgo(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
