// Mini mode's window placement (src/core/layout.ts).
import { describe, expect, it } from 'vitest'
import { placeWithin } from '../src/core/layout'

const area = { x: 0, y: 25, width: 1440, height: 875 }

describe('placeWithin', () => {
  it('keeps the top-left corner when the new size fits', () => {
    expect(
      placeWithin({ x: 100, y: 100, width: 1000, height: 700 }, { width: 380, height: 220 }, area)
    ).toEqual({ x: 100, y: 100, width: 380, height: 220 })
  })

  it('moves a window that would grow off the screen back inside it', () => {
    const corner = { x: 1050, y: 700, width: 380, height: 220 }
    expect(placeWithin(corner, { width: 600, height: 670 }, area)).toEqual({
      x: 840,
      y: 230,
      width: 600,
      height: 670
    })
  })

  it('moves a window that starts off the screen onto it', () => {
    expect(
      placeWithin({ x: -50, y: 0, width: 380, height: 220 }, { width: 380, height: 220 }, area)
    ).toEqual({ x: 0, y: 25, width: 380, height: 220 })
  })

  it('shrinks to the work area when it is too small', () => {
    const small = { x: 0, y: 0, width: 500, height: 400 }
    expect(
      placeWithin({ x: 10, y: 10, width: 1, height: 1 }, { width: 600, height: 670 }, small)
    ).toEqual({ x: 0, y: 0, width: 500, height: 400 })
  })

  it('works on a display left of the main one', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 }
    expect(
      placeWithin({ x: -400, y: 900, width: 380, height: 220 }, { width: 600, height: 670 }, left)
    ).toEqual({ x: -600, y: 370, width: 600, height: 670 })
  })
})
