import { AgentBrowser } from './dist/index.js'

const SITES = [
  { id: 'hn',   goal: 'analyze page', url: 'https://news.ycombinator.com' },
  { id: 'wiki', goal: 'analyze page', url: 'https://en.wikipedia.org/wiki/Main_Page' },
  { id: 'gh',   goal: 'analyze page', url: 'https://github.com' },
  { id: 'so',   goal: 'analyze page', url: 'https://stackoverflow.com' },
  { id: 'bbc',  goal: 'analyze page', url: 'https://www.bbc.com/news' },
  { id: 'vg',   goal: 'analyze page', url: 'https://www.theverge.com' },
  { id: 'rd',   goal: 'analyze page', url: 'https://www.reddit.com' },
]

const browser = new AgentBrowser({
  anthropic_api_key: process.env.ANTHROPIC_API_KEY,
  headless: true,
  stealth: true,
})

await browser.launch()

console.log(`Running ${SITES.length} sites in parallel...`)
const t0 = Date.now()

const results = await browser.executor.runParallel(SITES)

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`Done in ${elapsed}s\n`)

console.log(`${'Site'.padEnd(32)} ${'Type'.padEnd(12)} OK`)
console.log('-'.repeat(50))
for (let i = 0; i < SITES.length; i++) {
  const r = results[i]
  const url = SITES[i].url.replace('https://', '').split('/')[0]
  const type = r.success ? (r.output?.page_state?.page_type ?? '?') : 'ERROR'
  const ok = r.success ? '✓' : `✗  ${r.error?.slice(0, 60)}`
  console.log(`${url.padEnd(32)} ${String(type).padEnd(12)} ${ok}`)
}

await browser.close()
