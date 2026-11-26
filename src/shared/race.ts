export interface Point { x: number; y: number }

export interface Pose extends Point { heading: number }

export type TurningDirection = -1 | 1
export type RoundingStatus = 'tracking' | 'valid' | 'invalid' | 'unconfirmed' | 'abandoned'
export type EvidenceState = 'clear' | 'uncertain' | 'contact'

export interface Gate {
  id: string
  name: string
  center: Point
  bearing: number
  width: number
  buoySide: -1 | 1
  approach?: { center: Point; bearing: number; width: number }
  /** False for a pure finish/exit line. Defaults to true for ordinary marks. */
  rounding?: boolean
  /** Polar-angle direction around the mark. Defaults to buoySide. */
  direction?: TurningDirection
  /** Net signed angle required for a strict rounding, in degrees. */
  requiredAngle?: number
  /** Radius of the mark's protected water circle. */
  protectionRadius?: number
}

export interface Course {
  id: string
  name: string
  size: Point
  start: Point
  heading: number
  gates: Gate[]
  hazards: { id: string; center: Point; radius: number }[]
  requiredAngle?: number
  protectionRadius?: number
}

export interface HullShape {
  bow: number
  stern: number
  halfBeam: number
}

export interface RoundingPose extends Pose {
  time: number
}

export interface ContactEvidence {
  time: number
  position: Point
  clearance: number
  distance: number
  reason: 'hull' | 'angle' | 'side' | 'gate'
}

export interface UncertaintyEvidence {
  time: number
  position: Point
  clearance: number
  margin: number
  reason: string
}

export interface RoundingAttempt {
  id: string
  gateId: string
  gateName: string
  center: Point
  status: RoundingStatus
  startedAt: number
  decidedAt?: number
  direction: TurningDirection
  requiredAngle: number
  protectionRadius: number
  startAngle: number
  angle: number
  netAngle: number
  minClearance: number
  outside: boolean
  evidenceState: EvidenceState
  track: RoundingPose[]
  contacts: ContactEvidence[]
  uncertainties: UncertaintyEvidence[]
  hull?: HullShape
  uncertainty?: number
  reason?: string
}

export type WindMode = 'steady' | 'shifting'
export interface Wind { bearing: number; knots: number }
export interface Boat { position: Point; heading: number; knots: number; sheet: number; rudder: number }
export type RaceStatus = 'ready' | 'running' | 'paused' | 'finished' | 'abandoned'
export type EventKind = 'start' | 'mark' | 'collision' | 'deviation' | 'finish' | 'abandon' | 'review'
export interface RaceEvent {
  id: string
  time: number
  kind: EventKind
  position: Point
  label: string
  penalty: number
}
export interface Sample {
  time: number
  boat: Boat
  wind: Wind
  nextGate: number
  penalty: number
}
export interface Voyage {
  id: string
  date: string
  courseId: string
  windMode: WindMode
  status: 'finished' | 'abandoned'
  duration: number
  penalty: number
  samples: Sample[]
  events: RaceEvent[]
  roundings?: RoundingAttempt[]
  ruleSet?: 'classic' | 'strict'
  requiredAngle?: number
}
