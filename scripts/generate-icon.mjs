import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SIZE = 512
const pixels = new Uint8Array(SIZE * SIZE * 4)

function blend(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  const srcA = a / 255
  const dstA = pixels[i + 3] / 255
  const outA = srcA + dstA * (1 - srcA)
  if (outA === 0) return
  pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA)
  pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA)
  pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA)
  pixels[i + 3] = Math.round(outA * 255)
}

function roundedRect(x0, y0, x1, y1, radius, color) {
  const [r, g, b, a = 255] = color
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = x < x0 + radius ? x0 + radius : x >= x1 - radius ? x1 - radius - 1 : x
      const cy = y < y0 + radius ? y0 + radius : y >= y1 - radius ? y1 - radius - 1 : y
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > radius * radius) continue
      blend(x, y, r, g, b, a)
    }
  }
}

function rect(x0, y0, x1, y1, color) {
  roundedRect(x0, y0, x1, y1, 0, color)
}

const BLUE = [37, 99, 235]
const PANEL = [255, 255, 255, 235]
const LINE = [147, 168, 210]
const ARROW = [255, 255, 255]

roundedRect(8, 8, SIZE - 8, SIZE - 8, 96, BLUE)

roundedRect(52, 96, 232, 416, 18, PANEL)
roundedRect(280, 96, 460, 416, 18, PANEL)

for (const [x0, x1] of [
  [52, 232],
  [280, 460]
]) {
  rect(x0 + 16, 120, x1 - 16, 146, [59, 130, 246, 255])
  for (let row = 0; row < 3; row++) {
    const y = 180 + row * 64
    rect(x0 + 16, y, x1 - 16 - (row === 1 ? 36 : 0), y + 16, LINE)
    rect(x0 + 16, y + 24, x1 - 60, y + 32, [200, 212, 232])
  }
}

rect(238, 244, 262, 268, ARROW)
for (let i = 0; i <= 24; i++) {
  const x = 262 + i
  const half = 24 - i
  rect(x, 256 - half, x + 1, 256 + half, ARROW)
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

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'build')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'icon.png')
writeFileSync(outFile, png)
console.log(`icon written: ${outFile} (${png.length} bytes)`)
