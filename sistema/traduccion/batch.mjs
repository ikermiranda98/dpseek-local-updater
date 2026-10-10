import { readFileSync, writeFileSync } from 'node:fs'
const d = JSON.parse(readFileSync('en-dump.json', 'utf8'))
const batches = []; let cur = {}, size = 0
for (const [n, v] of Object.entries(d)) {
  const c = Object.values(v).join('').length
  if (size > 0 && size + c > 10500) { batches.push(cur); cur = {}; size = 0 }
  cur[n] = v; size += c
}
batches.push(cur)
batches.forEach((b, i) => writeFileSync(`en-batch-${i + 1}.json`, JSON.stringify(b, null, 1)))
console.log(batches.map((b, i) => `${i + 1}: ${Object.keys(b).join(',')}`).join('\n'))
