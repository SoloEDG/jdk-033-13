import { angleDelta, axis, cross, distance, normalize, pointAt, radians, subtract } from '../../../shared/math'
import type {
  ContactEvidence,
  EvidenceState,
  HullShape,
  Point,
  Pose,
  RoundingAttempt,
  RoundingPose,
  TurningDirection,
  UncertaintyEvidence,
} from '../../../shared/race'

export const DEFAULT_HULL: HullShape = { bow: 18, stern: 17, halfBeam: 8 }
export const DEFAULT_PROTECTION_RADIUS = 24
export const DEFAULT_REQUIRED_ANGLE = 360
const CONTACT_EPS = 1e-6

export interface TrackPoint extends Point {
  heading?: number
  time?: number
  accuracy?: number
  error?: number
  evidenceError?: number
}

function pointEvidenceError(point: TrackPoint): number {
  return Math.max(0, point.accuracy ?? point.evidenceError ?? point.error ?? 0)
}

export type DirectionInput = TurningDirection | 'cw' | 'ccw' | 'clockwise' | 'counterclockwise'

export function normalizeDirection(direction: DirectionInput | undefined): TurningDirection {
  return direction === 1 || direction === 'cw' || direction === 'clockwise' ? 1 : -1
}

export interface RoundingRuleOptions {
  center: Point
  direction: DirectionInput
  requiredAngle?: number
  protectionRadius?: number
  hull?: Partial<HullShape>
  /** Distance band in which exact-looking evidence is not trusted. */
  uncertainty?: number
  /** Alias for uncertainty, useful when callers think in sensor resolution. */
  evidenceMargin?: number
  tolerance?: number
  id?: string
  gateId?: string
  gateName?: string
  startedAt?: number
}

export interface SweepEvidence {
  status: EvidenceState
  /** Signed gap from the hull to the protected disk: minDistance - radius. */
  clearance: number
  distance: number
  margin: number
  time?: number
  position?: Pose
}

export function resolveHull(hull?: Partial<HullShape>): HullShape {
  return { ...DEFAULT_HULL, ...hull }
}

export function resolveUncertainty(options: Pick<RoundingRuleOptions, 'uncertainty' | 'evidenceMargin' | 'tolerance'>): number {
  return Math.max(0, options.uncertainty ?? 0, options.evidenceMargin ?? 0, options.tolerance ?? 0)
}

/** Polar angle in the screen coordinate system. Positive is clockwise on screen. */
export function polarAngle(center: Point, point: Point): number {
  return normalize(Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI)
}

/** Approximate the filled hull used by BoatGlyph. The long axis is heading. */
export function hullPolygon(pose: Pose, hullOption?: Partial<HullShape>): Point[] {
  const hull = resolveHull(hullOption)
  const forward = axis(pose.heading)
  const side = axis(pose.heading + 90)
  const local: Array<[number, number]> = [
    [-hull.stern, -hull.halfBeam * .625],
    [-hull.stern + 10, -hull.halfBeam],
    [-2, -hull.halfBeam * .94],
    [hull.bow - 8, -hull.halfBeam * .56],
    [hull.bow, 0],
    [hull.bow - 8, hull.halfBeam * .56],
    [-2, hull.halfBeam * .94],
    [-hull.stern + 10, hull.halfBeam],
    [-hull.stern, hull.halfBeam * .625],
  ]
  return local.map(([longitudinal, lateral]) => ({
    x: pose.x + forward.x * longitudinal + side.x * lateral,
    y: pose.y + forward.y * longitudinal + side.y * lateral,
  }))
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x)
    if (intersects) inside = !inside
  }
  return inside
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return distance(point, a)
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

export function distanceToPolygon(point: Point, polygon: Point[]): number {
  if (pointInPolygon(point, polygon)) return 0
  let min = Infinity
  for (let i = 0; i < polygon.length; i++) {
    min = Math.min(min, distanceToSegment(point, polygon[i], polygon[(i + 1) % polygon.length]))
  }
  return min
}

export function interpolateTrackPoint(a: TrackPoint, b: TrackPoint, t: number): Pose & { time?: number } {
  return {
    ...pointAt(a, b, t),
    heading: normalize((a.heading ?? 0) + angleDelta(a.heading ?? 0, b.heading ?? a.heading ?? 0) * t),
    time: a.time === undefined || b.time === undefined ? undefined : a.time + (b.time - a.time) * t,
  }
}

/**
 * Continuously sample the translated and rotated hull. Dense sub-steps make
 * heading phase matter even when center tracks are almost identical.
 */
export function evaluateHullSweep(aInput: TrackPoint, bInput: TrackPoint, options: RoundingRuleOptions): SweepEvidence {
  const radius = options.protectionRadius ?? DEFAULT_PROTECTION_RADIUS
  const margin = Math.max(resolveUncertainty(options), pointEvidenceError(aInput), pointEvidenceError(bInput))
  const hull = resolveHull(options.hull)
  const movementDistance = distance(aInput, bInput)
  const movementHeading = movementDistance > 1e-6
    ? Math.atan2(bInput.y - aInput.y, bInput.x - aInput.x) * 180 / Math.PI
    : undefined
  const a: TrackPoint = { ...aInput, heading: aInput.heading ?? movementHeading ?? 0 }
  const b: TrackPoint = { ...bInput, heading: bInput.heading ?? movementHeading ?? a.heading }
  const centerDistance = movementDistance
  const headingChange = Math.abs(angleDelta(a.heading ?? 0, b.heading ?? a.heading ?? 0))
  const headingArc = radians(headingChange) * Math.max(hull.bow, hull.stern)
  const steps = Math.max(1, Math.min(512, Math.ceil(Math.max(centerDistance / .7, headingArc / .55))))

  let minDistance = Infinity
  let closestPose: (Pose & { time?: number }) | null = null
  let firstContact: { time?: number; position: Pose; distance: number } | null = null
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const pose = interpolateTrackPoint(a, b, t)
    const hullDistance = distanceToPolygon(options.center, hullPolygon(pose, hull))
    if (hullDistance < minDistance) {
      minDistance = hullDistance
      closestPose = { x: pose.x, y: pose.y, heading: pose.heading, time: pose.time }
    }
    if (!firstContact && hullDistance <= radius + CONTACT_EPS) {
      firstContact = { time: pose.time, position: { x: pose.x, y: pose.y, heading: pose.heading }, distance: hullDistance }
    }
  }

  const clearance = minDistance - radius
  if (firstContact) {
    return {
      status: 'contact', clearance: firstContact.distance - radius, distance: firstContact.distance,
      margin, time: firstContact.time, position: firstContact.position,
    }
  }
  return {
    status: clearance <= margin + CONTACT_EPS ? 'uncertain' : 'clear',
    clearance, distance: minDistance, margin,
    time: closestPose?.time,
    position: closestPose ? { x: closestPose.x, y: closestPose.y, heading: closestPose.heading } : undefined,
  }
}

let attemptSequence = 0

export function createRoundingAttempt(first: TrackPoint, options: RoundingRuleOptions): RoundingAttempt {
  const direction = normalizeDirection(options.direction)
  const requiredAngle = options.requiredAngle ?? DEFAULT_REQUIRED_ANGLE
  const protectionRadius = options.protectionRadius ?? DEFAULT_PROTECTION_RADIUS
  const angle = polarAngle(options.center, first)
  const pose: RoundingPose = {
    time: first.time ?? options.startedAt ?? 0,
    x: first.x,
    y: first.y,
    heading: first.heading ?? 0,
  }
  attemptSequence += 1
  const hull = resolveHull(options.hull)
  const initialClearance = distanceToPolygon(options.center, hullPolygon({ x: pose.x, y: pose.y, heading: pose.heading }, hull)) - protectionRadius
  return {
    id: options.id ?? `rounding-${Date.now().toString(36)}-${attemptSequence}`,
    gateId: options.gateId ?? options.id ?? 'mark',
    gateName: options.gateName ?? '标',
    center: { ...options.center },
    status: 'tracking',
    startedAt: pose.time,
    direction,
    requiredAngle,
    protectionRadius,
    startAngle: angle,
    angle,
    netAngle: 0,
    minClearance: initialClearance,
    outside: true,
    evidenceState: 'clear',
    track: [pose],
    contacts: [],
    uncertainties: [],
    hull,
    uncertainty: resolveUncertainty(options),
  } as RoundingAttempt
}

/** Append one evidence pose, update signed net angle and hull-protection evidence. */
export function appendRoundingPose(attempt: RoundingAttempt, next: TrackPoint): SweepEvidence {
  const last = attempt.track.at(-1)
  if (!last) throw new Error('Rounding attempt has no initial pose')
  const rawAngle = polarAngle(attempt.center, next)
  const angularDelta = angleDelta(normalize(attempt.angle), rawAngle)
  const angularAmbiguous = Math.abs(angularDelta) >= 180 - 1e-6
  attempt.angle += angularDelta
  attempt.netAngle = attempt.direction * (attempt.angle - attempt.startAngle)

  const sweep = evaluateHullSweep(last, next, {
    center: attempt.center,
    direction: attempt.direction,
    protectionRadius: attempt.protectionRadius,
    hull: attempt.hull,
    uncertainty: attempt.uncertainty ?? 0,
  })
  attempt.minClearance = Math.min(attempt.minClearance, sweep.clearance)

  const poseHeading = next.heading ?? (distance(last, next) > 1e-6
    ? Math.atan2(next.y - last.y, next.x - last.x) * 180 / Math.PI
    : last.heading)
  const pose: RoundingPose = {
    time: next.time ?? last.time,
    x: next.x,
    y: next.y,
    heading: poseHeading,
  }
  attempt.track.push(pose)

  if (sweep.status === 'contact' && sweep.position) {
    attempt.status = 'invalid'
    if (attempt.evidenceState !== 'contact') {
      const contact: ContactEvidence = {
        time: sweep.time ?? pose.time,
        position: { ...sweep.position },
        clearance: sweep.clearance,
        distance: sweep.distance,
        reason: 'hull',
      }
      attempt.contacts.push(contact)
    }
  } else if (sweep.status === 'uncertain' || angularAmbiguous) {
    if (attempt.status === 'tracking') attempt.status = 'unconfirmed'
    if (attempt.evidenceState !== 'uncertain') {
      const uncertainty: UncertaintyEvidence = {
        time: sweep.time ?? pose.time,
        position: sweep.position ? { ...sweep.position } : { x: pose.x, y: pose.y, heading: pose.heading },
        clearance: sweep.clearance,
        margin: sweep.margin,
        reason: angularAmbiguous
          ? '相邻证据的绕标相位接近或超过 180°，无法分辨净绕方向'
          : '采样间隔或证据误差使保护圈边界无法分辨',
      }
      attempt.uncertainties.push(uncertainty)
    }
  }
  attempt.evidenceState = sweep.status === 'clear' && angularAmbiguous ? 'uncertain' : sweep.status
  return sweep
}

export interface FinalizeOptions {
  time?: number
  outside?: boolean
  outsideScore?: number
  exit?: boolean
  reason?: string
}

export function finalizeRoundingAttempt(attempt: RoundingAttempt, options: FinalizeOptions = {}): RoundingAttempt {
  if (attempt.status === 'abandoned') return attempt
  const last = attempt.track.at(-1)
  const time = options.time ?? last?.time ?? attempt.startedAt
  attempt.decidedAt = time
  if (options.outside !== undefined) attempt.outside = options.outside

  if (attempt.contacts.length) {
    attempt.status = 'invalid'
    attempt.reason = '船身擦碰保护圈，本次绕行失效'
  } else if (attempt.uncertainties.length) {
    attempt.status = 'unconfirmed'
    attempt.reason = options.reason ?? '证据无法分辨是否擦圈，保留未确认尝试'
  } else if (attempt.netAngle + 1e-4 < attempt.requiredAngle) {
    attempt.status = 'invalid'
    attempt.reason = `净绕行 ${Math.max(0, attempt.netAngle).toFixed(0)}°，未达到 ${attempt.requiredAngle}°`
  } else if (options.outside === false) {
    attempt.status = 'invalid'
    attempt.reason = '未从规定的标外侧通过'
  } else if (options.exit === false) {
    attempt.status = 'unconfirmed'
    attempt.reason = '尚未经过出口，绕行未确认'
  } else {
    attempt.status = 'valid'
    attempt.reason = '净绕行、外侧通道与保护圈检查均合规'
  }
  return attempt
}

/** Adapt logbook/replay samples into the flattened evidence-track shape. */
export function trackFromSamples(samples: Array<{ time: number; boat: { position: Point; heading: number } }>): TrackPoint[] {
  return samples.map(sample => ({
    time: sample.time,
    x: sample.boat.position.x,
    y: sample.boat.position.y,
    heading: sample.boat.heading,
  }))
}

/** Batch adjudication for recorded or synthetic evidence tracks. */
export function evaluateRoundingTrack(track: TrackPoint[], options: RoundingRuleOptions & FinalizeOptions): RoundingAttempt {
  if (!track.length) throw new Error('Rounding track must contain at least one pose')
  const first = track[0]
  const attempt = createRoundingAttempt({ ...first, time: first.time ?? options.startedAt ?? 0 }, options)
  for (let i = 1; i < track.length; i++) appendRoundingPose(attempt, track[i])
  const last = track.at(-1)!
  const outsideScore = correctSideScore({ x: last.x, y: last.y, heading: last.heading ?? 0 }, options.center, attempt.direction)
  return finalizeRoundingAttempt(attempt, {
    time: last.time,
    outside: options.outside ?? outsideScore >= -1e-4,
    exit: options.exit,
  })
}

/** Positive means the mark is on the inside of the prescribed rounding side. */
export function correctSideScore(pose: Pose, center: Point, direction: TurningDirection, bearing?: number): number {
  const forward = axis(bearing ?? pose.heading)
  return direction * cross(forward, subtract(center, pose))
}

export function netAngleSeries(track: TrackPoint[], center: Point, direction: TurningDirection): Array<{ time: number; angle: number; net: number }> {
  if (!track.length) return []
  let angle = polarAngle(center, track[0])
  const start = angle
  return track.map((point, index) => {
    if (index > 0) angle += angleDelta(normalize(angle), polarAngle(center, point))
    return { time: point.time ?? index, angle, net: direction * (angle - start) }
  })
}

export function netRoundingAngle(track: TrackPoint[], center: Point, direction: TurningDirection): number {
  return netAngleSeries(track, center, direction).at(-1)?.net ?? 0
}

export function polygonPath(polygon: Point[]): string {
  if (!polygon.length) return ''
  return `M${polygon[0].x.toFixed(2)},${polygon[0].y.toFixed(2)}` +
    polygon.slice(1).map(point => `L${point.x.toFixed(2)},${point.y.toFixed(2)}`).join('') + 'Z'
}

/** Dense filled hull outlines whose union is the swept-water envelope. */
export function sweptHullPolygons(track: TrackPoint[], hull?: Partial<HullShape>, spacing = 2.2): Point[][] {
  if (!track.length) return []
  const polygons: Point[][] = [hullPolygon({ x: track[0].x, y: track[0].y, heading: track[0].heading ?? 0 }, hull)]
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i]
    const centerDistance = distance(a, b)
    const headingArc = radians(Math.abs(angleDelta(a.heading ?? 0, b.heading ?? a.heading ?? 0))) *
      Math.max(resolveHull(hull).bow, resolveHull(hull).stern)
    const steps = Math.max(1, Math.ceil(Math.max(centerDistance / spacing, headingArc / spacing)))
    for (let j = 1; j <= steps; j++) {
      const pose = interpolateTrackPoint(a, b, j / steps)
      polygons.push(hullPolygon(pose, hull))
    }
  }
  return polygons
}

export function sweptWaterPath(track: TrackPoint[], hull?: Partial<HullShape>, spacing = 2.2): string {
  return sweptHullPolygons(track, hull, spacing).map(polygonPath).join('')
}

export const computeSweptWater = sweptHullPolygons
export const judgeRounding = evaluateRoundingTrack
export const adjudicateRounding = evaluateRoundingTrack
export type RoundingEvidence = RoundingAttempt
export const evaluateSampleRounding = (
  samples: Parameters<typeof trackFromSamples>[0],
  options: RoundingRuleOptions & FinalizeOptions,
) => evaluateRoundingTrack(trackFromSamples(samples), options)

export class RoundingJudge {
  readonly attempt: RoundingAttempt
  constructor(options: RoundingRuleOptions, first?: TrackPoint) {
    this.attempt = createRoundingAttempt(first ?? { ...options.center, heading: 0, time: options.startedAt ?? 0 }, options)
  }
  record(point: TrackPoint): SweepEvidence {
    return appendRoundingPose(this.attempt, point)
  }
  finish(options: FinalizeOptions = {}): RoundingAttempt {
    return finalizeRoundingAttempt(this.attempt, options)
  }
  get verdict(): RoundingAttempt {
    return this.attempt
  }
}

export function evidenceAtTime<T extends RoundingAttempt>(attempts: T[] | undefined, time: number): T | null {
  if (!attempts?.length) return null
  const started = attempts.filter(attempt => attempt.startedAt <= time + 1e-6)
  return started.at(-1) ?? null
}

/** Cut review evidence at the replay playhead and recompute visible net angle. */
export function sliceAttemptAt<T extends RoundingAttempt>(attempt: T, time: number): T {
  if (time >= (attempt.decidedAt ?? Infinity)) return attempt
  const visible = attempt.track.filter(pose => pose.time <= time + 1e-6)
  if (!visible.length) {
    const first = attempt.track[0]
    visible.push({ ...first, time })
  } else {
    const lastVisible = visible.at(-1)!
    const next = attempt.track.find(pose => pose.time > time + 1e-6)
    if (next && lastVisible.time < time) {
      visible.push({ ...interpolateTrackPoint(lastVisible, next, (time - lastVisible.time) / (next.time - lastVisible.time)), time } as RoundingPose)
    }
  }

  let angle = polarAngle(attempt.center, visible[0])
  let minClearance = 9999
  for (let i = 1; i < visible.length; i++) {
    angle += angleDelta(normalize(angle), polarAngle(attempt.center, visible[i]))
    minClearance = Math.min(minClearance, evaluateHullSweep(visible[i - 1], visible[i], {
      center: attempt.center,
      direction: attempt.direction,
      protectionRadius: attempt.protectionRadius,
      hull: attempt.hull,
      uncertainty: attempt.uncertainty ?? 0,
    }).clearance)
  }
  const netAngle = attempt.direction * (angle - attempt.startAngle)
  const uncertainties = attempt.uncertainties.filter(item => item.time <= time + 1e-6)
  const contacts = attempt.contacts.filter(item => item.time <= time + 1e-6)
  const decided = attempt.decidedAt !== undefined && time + 1e-6 >= attempt.decidedAt
  return {
    ...attempt,
    track: visible,
    angle,
    netAngle,
    minClearance: visible.length > 1 ? minClearance : attempt.minClearance,
    contacts,
    uncertainties,
    status: decided ? attempt.status : contacts.length ? 'invalid' : uncertainties.length ? 'unconfirmed' : 'tracking',
  }
}
