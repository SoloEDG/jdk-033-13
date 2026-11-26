import type { Point } from './race'

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
export const radians = (degrees: number) => degrees * Math.PI / 180
export const normalize = (degrees: number) => ((degrees % 360) + 360) % 360
export const angleDelta = (from: number, to: number) => normalize(to - from + 180) - 180
export const axis = (degrees: number): Point => ({ x: Math.cos(radians(degrees)), y: Math.sin(radians(degrees)) })
export const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
export const scale = (a: Point, n: number): Point => ({ x: a.x * n, y: a.y * n })
export const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x
export const squaredDistance = (a: Point, b: Point): number => {
  const x = a.x - b.x, y = a.y - b.y
  return x * x + y * y
}
export const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export const mix = (a: number, b: number, t: number) => a + (b - a) * t
export const pointAt = (a: Point, b: Point, t: number): Point => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) })
