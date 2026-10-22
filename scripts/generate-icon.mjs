import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUPERSAMPLE = 4

const ARROW_STROKES = [
  [8, 3, 4, 7],
  [4, 7, 8, 11],
  [4, 7, 20, 7],
  [16, 21, 20, 17],
  [20, 17, 16, 13],
  [20, 17, 4, 17]
]

const BLUE = [59, 130, 246]
const INDIGO = [79, 70, 229]
const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function lerpColor(from, to, t) {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t
  ]
}

function createCanvas(size) {
  const width = size * SUPERSAMPLE
  return { size, width, data: new Float64Array(width * width * 4) }
}

function writePixel(canvas, x, y, color) {
  const index = (y * canvas.width + x) * 4
  canvas.data[index] = color[0] / 255
  canvas.data[index + 1] = color[1] / 255
  canvas.data[index + 2] = color[2] / 255
  canvas.data[index + 3] = 1
}

function paintRoundedRect(canvas, x0, y0, x1, y1, radius, colorAt) {
  const scale = SUPERSAMPLE
  const startX = Math.max(0, Math.floor(x0 * scale))
  const startY = Math.max(0, Math.floor(y0 * scale))
  const endX = Math.min(canvas.width, Math.ceil(x1 * scale))
  const endY = Math.min(canvas.width, Math.ceil(y1 * scale))
  for (let y = startY; y < endY; y++) {
    const py = (y + 0.5) / scale
    for (let x = startX; x < endX; x++) {
      const px = (x + 0.5) / scale
      const cx = Math.min(Math.max(px, x0 + radius), x1 - radius)
      const cy = Math.min(Math.max(py, y0 + radius), y1 - radius)
      if ((px - cx) ** 2 + (py - cy) ** 2 > radius ** 2) continue
      writePixel(canvas, x, y, colorAt(px, py))
    }
  }
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / lengthSquared)
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function paintCapsule(canvas, x1, y1, x2, y2, width, color) {
  const scale = SUPERSAMPLE
  const radius = width / 2
  const startX = Math.max(0, Math.floor((Math.min(x1, x2) - radius) * scale))
  const startY = Math.max(0, Math.floor((Math.min(y1, y2) - radius) * scale))
  const endX = Math.min(canvas.width, Math.ceil((Math.max(x1, x2) + radius) * scale))
  const endY = Math.min(canvas.width, Math.ceil((Math.max(y1, y2) + radius) * scale))
  for (let y = startY; y < endY; y++) {
    const py = (y + 0.5) / scale
    for (let x = startX; x < endX; x++) {
      const px = (x + 0.5) / scale
      if (distanceToSegment(px, py, x1, y1, x2, y2) > radius) continue
      writePixel(canvas, x, y, color)
    }
  }
}

function paintArrowMark(canvas, center, scale, stroke, color) {
  for (const [x1, y1, x2, y2] of ARROW_STROKES) {
    paintCapsule(
      canvas,
      center + (x1 - 12) * scale,
      center + (y1 - 12) * scale,
      center + (x2 - 12) * scale,
      center + (y2 - 12) * scale,
      stroke * scale,
      color
    )
  }
}

function toRgba(canvas) {
  const { size, width, data } = canvas
  const samples = SUPERSAMPLE * SUPERSAMPLE
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const index = ((y * SUPERSAMPLE + sy) * width + x * SUPERSAMPLE + sx) * 4
          const a = data[index + 3]
          red += data[index] * a
          green += data[index + 1] * a
          blue += data[index + 2] * a
          alpha += a
        }
      }
      const index = (y * size + x) * 4
      if (alpha > 0) {
        rgba[index] = Math.round((red / alpha) * 255)
        rgba[index + 1] = Math.round((green / alpha) * 255)
        rgba[index + 2] = Math.round((blue / alpha) * 255)
      }
      rgba[index + 3] = Math.round((alpha / samples) * 255)
    }
  }
  return rgba
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function writeIcon(file, canvas) {
  const target = path.join(ROOT, file)
  mkdirSync(path.dirname(target), { recursive: true })
  const png = encodePng(canvas.size, toRgba(canvas))
  writeFileSync(target, png)
  console.log(`icon written: ${target} (${png.length} bytes)`)
}

const appIcon = createCanvas(512)
paintRoundedRect(appIcon, 8, 8, 504, 504, 112, (px, py) =>
  lerpColor(BLUE, INDIGO, clamp01(((px - 8) / 496 + (py - 8) / 496) / 2))
)
paintArrowMark(appIcon, 256, 17, 2.25, WHITE)
writeIcon('build/icon.png', appIcon)

const trayIcon = createCanvas(32)
paintRoundedRect(trayIcon, 1, 1, 31, 31, 7, (px, py) =>
  lerpColor(BLUE, INDIGO, clamp01(((px - 1) / 30 + (py - 1) / 30) / 2))
)
paintArrowMark(trayIcon, 16, 1, 2.35, WHITE)
writeIcon('resources/tray.png', trayIcon)

const trayTemplate = createCanvas(16)
paintArrowMark(trayTemplate, 8, 0.74, 2.4, BLACK)
writeIcon('resources/trayTemplate.png', trayTemplate)

const trayTemplateRetina = createCanvas(32)
paintArrowMark(trayTemplateRetina, 16, 1.48, 2.4, BLACK)
writeIcon('resources/trayTemplate@2x.png', trayTemplateRetina)
