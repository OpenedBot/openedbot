import { describe, expect, test } from 'bun:test'
import { BotEngine } from './engine'
import { RAYON } from './repere'
import { PROFILES } from './profiles'

/** Les nombres d'un chemin, dans l'ordre, par paires (x, y). */
function coords(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/** `translate(tx ty) scale(1 k)` -> les trois nombres. */
function lireTransform(t: string): { tx: number; ty: number; k: number } {
  const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) scale\(1 (-?[\d.]+)\)$/.exec(t)
  if (!m) throw new Error(`transform illisible : ${t}`)
  return { tx: Number(m[1]), ty: Number(m[2]), k: Number(m[3]) }
}

/** Le chemin du repere propre, replace dans le repere absolu. */
function applique(d: string, t: string): number[] {
  const { tx, ty, k } = lireTransform(t)
  return coords(d).map((v, i) => (i % 2 === 0 ? v + tx : k * v + ty))
}

const neuf = () => new BotEngine(RAYON, 'idle')

describe('sample(now, corpsTransforme)', () => {
  test('les deux reperes decrivent la meme image', () => {
    const absolu = neuf()
    const propre = neuf()
    let pire = 0
    for (let i = 0; i < 900; i += 1) {
      const t = i / 60
      const a = coords(absolu.sample(t).bodyPath)
      const frame = propre.sample(t, true)
      const b = applique(frame.bodyPath, frame.bodyTransform)
      expect(b.length).toBe(a.length)
      for (let j = 0; j < a.length; j += 1) pire = Math.max(pire, Math.abs(a[j]! - b[j]!))
    }
    // `r2` arrondit au centieme d'unite de viewBox, des DEUX cotes : deux
    // centiemes est la borne du desaccord possible, et il n'y en a pas d'autre.
    // Sur une pastille de 28 px, c'est 0,002 px.
    expect(pire).toBeLessThan(0.02)
  })

  test('le repos ne reconstruit jamais le contour', () => {
    const engine = neuf()
    const premier = engine.sample(0, true).bodyPath
    for (let i = 1; i < 900; i += 1) {
      // identite de chaine, pas egalite : c'est l'absence de reconstruction
      // qu'on verrouille, pas la ressemblance du resultat.
      expect(engine.sample(i / 60, true).bodyPath).toBe(premier)
    }
  })

  test('le repere absolu, lui, reconstruit a chaque image', () => {
    const engine = neuf()
    const premier = engine.sample(0).bodyPath
    expect(engine.sample(1, false).bodyPath).not.toBe(premier)
  })

  test('la respiration survit a l’arrondi de l’echelle', () => {
    const engine = neuf()
    const echelles = new Set<number>()
    for (let i = 0; i < 600; i += 1) echelles.add(lireTransform(engine.sample(i / 60, true).bodyTransform).k)
    expect(echelles.size).toBeGreaterThan(20)
    for (const k of echelles) {
      expect(k).toBeGreaterThan(0.9)
      expect(k).toBeLessThan(1.1)
    }
  })

  test('un changement de forme invalide le contour garde', () => {
    // une forme de depart, sinon `setShape` saute au lieu de morpher
    const engine = new BotEngine(RAYON, 'idle', [...PROFILES.egg])
    const rond = engine.sample(0, true).bodyPath
    engine.setShape([...PROFILES.hexagon], 0)
    // pendant le morphing la silhouette change a chaque image : rien n'est garde
    const pendant = engine.sample(0.2, true).bodyPath
    expect(pendant).not.toBe(rond)
    expect(engine.sample(0.3, true).bodyPath).not.toBe(pendant)
    // le morphing fini, la nouvelle forme est gardee a son tour
    const apres = engine.sample(5, true).bodyPath
    expect(engine.sample(6, true).bodyPath).toBe(apres)
    expect(apres).not.toBe(rond)
  })
})
