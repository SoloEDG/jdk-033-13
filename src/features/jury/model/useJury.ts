import { ref } from 'vue'
import { buoyPosition, inspectWater, isOffCourse } from '../../chart/lib/geometry'
import type { Boat, Course, EventKind, Point, RaceEvent, RoundingAttempt, RoundingPose } from '../../../shared/race'
import { gateCrossing } from '../lib/crossing'
import {
  appendRoundingPose,
  correctSideScore,
  createRoundingAttempt,
  evaluateHullSweep,
  finalizeRoundingAttempt,
  interpolateTrackPoint,
} from '../lib/rounding'

export interface InspectionVerdict {
  blocked: boolean
  finish: { time: number; position: Point } | null
}

export type JuryInspectionInput = Boat | (Point & { heading?: number })

function asBoat(input: JuryInspectionInput): Boat {
  if ('position' in input) return input
  return {
    position: { x: input.x, y: input.y },
    heading: input.heading ?? 0,
    knots: 0,
    sheet: 0,
    rudder: 0,
  }
}

export function useJury(course: Course) {
  const nextGate = ref(0)
  const penalty = ref(0)
  const events = ref<RaceEvent[]>([])
  const strict = ref(true)
  const requiredAngle = ref(course.requiredAngle ?? 360)
  const evidenceMargin = ref(.35)
  const attempts = ref<RoundingAttempt[]>([])
  const activeAttempt = ref<RoundingAttempt | null>(null)
  let contacts = new Set<string>()
  let outside = false
  let approached = false

  function add(kind: EventKind, label: string, time: number, position: Point, seconds = 0) {
    penalty.value += seconds
    events.value.push({ id: String(events.value.length + 1), kind, label, time, position: { ...position }, penalty: seconds })
  }

  function reset() {
    nextGate.value = penalty.value = 0
    events.value = []
    attempts.value = []
    activeAttempt.value = null
    contacts = new Set()
    outside = false
    approached = false
  }

  function setStrict(value: boolean) {
    strict.value = value
    activeAttempt.value = null
    approached = false
  }

  function setRequiredAngle(value: number) {
    requiredAngle.value = value
  }

  function boatPose(boat: Boat, time: number): RoundingPose {
    return { x: boat.position.x, y: boat.position.y, heading: boat.heading, time }
  }

  function archiveEvidence(): RoundingAttempt[] {
    return attempts.value.map(attempt => ({
      ...attempt,
      center: { ...attempt.center },
      startAngle: attempt.startAngle,
      track: attempt.track.map(pose => ({ ...pose })),
      contacts: attempt.contacts.map(contact => ({ ...contact, position: { ...contact.position } })),
      uncertainties: attempt.uncertainties.map(item => ({ ...item, position: { ...item.position } })),
    }))
  }

  function abandonActive(time: number) {
    const attempt = activeAttempt.value
    if (!attempt) return
    attempt.decidedAt = time
    if (attempt.uncertainties.length) {
      attempt.status = 'unconfirmed'
      finalizeRoundingAttempt(attempt, { time })
    } else {
      attempt.status = 'abandoned'
      attempt.reason = '航次结束，尝试未完成'
    }
    activeAttempt.value = null
  }

  function inspectClassic(from: Boat, to: Boat, start: number, dt: number): InspectionVerdict {
    const gate = course.gates[nextGate.value]
    if (!gate) return { blocked: false, finish: null }
    if (gate.approach) {
      if (gateCrossing(gate.approach, to.position, from.position)) approached = false
      if (gateCrossing(gate.approach, from.position, to.position)) approached = true
    }
    const hit = (!gate.approach || approached) ? gateCrossing(gate, from.position, to.position) : null
    const legStart = nextGate.value === 0 ? course.start : course.gates[nextGate.value - 1].center
    const offCourse = isOffCourse(legStart, gate, to.position)
    if (hit) {
      nextGate.value++
      approached = false
      outside = false
      const time = start + dt * hit.fraction
      if (nextGate.value === course.gates.length) {
        add('finish', '冲过终点', time, hit.point)
        return { blocked: false, finish: { time, position: hit.point } }
      }
      add('mark', `通过 ${gate.name}`, time, hit.point)
    } else {
      if (offCourse && !outside) add('deviation', '偏离航段', start + dt, to.position, 3)
      outside = offCourse
    }
    return { blocked: false, finish: null }
  }

  function startStrictAttempt(gate: (typeof course.gates)[number], fraction: number, start: number, dt: number, from: Boat, to: Boat) {
    const time = start + dt * fraction
    const pose = interpolateTrackPoint(
      boatPose(from, start),
      boatPose(to, start + dt),
      fraction,
    )
    const attempt = createRoundingAttempt(
      { x: pose.x, y: pose.y, heading: pose.heading, time },
      {
        gateId: gate.id,
        gateName: gate.name,
        center: buoyPosition(gate),
        direction: gate.direction ?? gate.buoySide,
        requiredAngle: requiredAngle.value,
        protectionRadius: gate.protectionRadius ?? course.protectionRadius ?? 24,
        uncertainty: evidenceMargin.value,
      },
    )
    attempts.value.push(attempt)
    activeAttempt.value = attempt
  }

  function observeStrictPose(attempt: RoundingAttempt, pose: RoundingPose): InspectionVerdict | null {
    const last = attempt.track.at(-1)!
    const sweep = evaluateHullSweep(last, pose, {
      center: attempt.center,
      direction: attempt.direction,
      protectionRadius: attempt.protectionRadius,
      hull: attempt.hull,
      uncertainty: attempt.uncertainty ?? evidenceMargin.value,
    })

    if (sweep.status === 'contact' && sweep.position) {
      const contactTime = sweep.time ?? pose.time
      const contactPose = { ...sweep.position, time: contactTime }
      appendRoundingPose(attempt, contactPose)
      const contact = attempt.contacts.at(-1)
      finalizeRoundingAttempt(attempt, { time: contactTime })
      add('collision', `擦碰保护圈 · ${attempt.gateName}`, contactTime, contact?.position ?? sweep.position, 5)
      activeAttempt.value = null
      approached = false
      return { blocked: true, finish: null }
    }

    appendRoundingPose(attempt, pose)
    return null
  }

  function decideStrict(gate: (typeof course.gates)[number], pose: RoundingPose, time: number): InspectionVerdict {
    const attempt = activeAttempt.value
    if (!attempt) return { blocked: false, finish: null }
    const sideScore = correctSideScore(pose, attempt.center, attempt.direction, gate.bearing)
    finalizeRoundingAttempt(attempt, { time, outside: sideScore >= -1e-3 })

    if (attempt.status === 'valid') {
      nextGate.value++
      approached = false
      outside = false
      add('mark', `严格绕行合规 · ${gate.name}`, time, { x: pose.x, y: pose.y })
      activeAttempt.value = null
      if (nextGate.value === course.gates.length) {
        add('finish', '冲过终点', time, pose)
        return { blocked: false, finish: { time, position: { ...pose } } }
      }
    } else if (attempt.status === 'unconfirmed') {
      add('review', `未确认尝试 · ${gate.name}`, time, { x: pose.x, y: pose.y })
      activeAttempt.value = null
      approached = false
    } else {
      add('review', `绕行失效 · ${gate.name}`, time, { x: pose.x, y: pose.y })
      activeAttempt.value = null
      approached = false
    }
    return { blocked: false, finish: null }
  }

  function inspectStrict(from: Boat, to: Boat, start: number, dt: number): InspectionVerdict {
    const gate = course.gates[nextGate.value]
    if (!gate || gate.rounding === false) return inspectClassic(from, to, start, dt)

    if (gate.approach) {
      if (gateCrossing(gate.approach, to.position, from.position)) approached = false
      if (gateCrossing(gate.approach, from.position, to.position)) approached = true
    }

    let crossing = (!gate.approach || approached) ? gateCrossing(gate, from.position, to.position) : null
    if (!activeAttempt.value && crossing) {
      startStrictAttempt(gate, crossing.fraction, start, dt, from, to)
      // The first gate crossing is the entry/reference ray, not the verdict.
      crossing = null
    }

    const attempt = activeAttempt.value
    if (attempt) {
      if (crossing) {
        const time = start + dt * crossing.fraction
        const crossingPose = interpolateTrackPoint(
          boatPose(from, start),
          boatPose(to, start + dt),
          crossing.fraction,
        ) as RoundingPose
        crossingPose.time = time
        const contact = observeStrictPose(attempt, crossingPose)
        if (contact) return contact
        const verdict = decideStrict(gate, crossingPose, time)
        if (verdict.finish) return verdict
      } else {
        const pose = boatPose(to, start + dt)
        const contact = observeStrictPose(attempt, pose)
        if (contact) return contact
      }
    }

    const legStart = nextGate.value === 0 ? course.start : course.gates[nextGate.value - 1].center
    const offCourse = isOffCourse(legStart, gate, to.position)
    if (offCourse && !outside) add('deviation', '偏离航段', start + dt, to.position, 3)
    outside = offCourse
    return { blocked: false, finish: null }
  }

  function inspect(fromInput: JuryInspectionInput, toInput: JuryInspectionInput, start: number, dt: number): InspectionVerdict {
    const from = asBoat(fromInput)
    const to = asBoat(toInput)
    const gate = course.gates[nextGate.value]
    if (!gate) return { blocked: false, finish: null }

    const newContacts = new Set(inspectWater(course, to.position))
    for (const name of newContacts) if (!contacts.has(name)) add('collision', `碰撞 · ${name}`, start + dt, from.position, 5)
    if (newContacts.size) {
      for (const name of newContacts) contacts.add(name)
      return { blocked: true, finish: null }
    }
    if (contacts.size) {
      const nearby = new Set(inspectWater(course, to.position, 3))
      for (const name of contacts) if (!nearby.has(name)) contacts.delete(name)
    }

    if (!strict.value || gate.rounding === false) return inspectClassic(from, to, start, dt)
    return inspectStrict(from, to, start, dt)
  }

  return {
    nextGate,
    penalty,
    events,
    strict,
    requiredAngle,
    evidenceMargin,
    attempts,
    activeAttempt,
    roundings: attempts,
    currentAttempt: activeAttempt,
    reset,
    add,
    inspect,
    setStrict,
    setRequiredAngle,
    archiveEvidence,
    abandonActive,
  }
}
