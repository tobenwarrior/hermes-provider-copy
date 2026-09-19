/**
 * Desktop-half test — mirrors the app's runtime loader: rewrite bare
 * specifiers to stubs, dynamic-import the module, validate the default export,
 * call register(ctx) with a recording context, render the page across its
 * states, and check every t('key') used in the source exists in the en bundle.
 *
 *   node tests/desktop_plugin_test.mjs [path/to/plugin.js] [scratch-dir]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(process.argv[2] ?? join(HERE, '..', 'desktop', 'plugin.js'))
const OUT = resolve(process.argv[3] ?? join(tmpdir(), 'provider-copy-desktop-test'))
mkdirSync(OUT, { recursive: true })

// ---- stubs the loader provides as live shim blobs -------------------------
const sdkStub = `export const Badge = 'Badge'
export const Button = 'Button'
export const Checkbox = 'Checkbox'
export const EmptyState = 'EmptyState'
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const Select = 'Select'
export const SelectContent = 'SelectContent'
export const SelectItem = 'SelectItem'
export const SelectTrigger = 'SelectTrigger'
export const SelectValue = 'SelectValue'
export const cn = (...a) => a.filter(Boolean).join(' ')
export const haptic = () => {}
export const host = { state: {}, notify: () => {}, notifyError: () => {}, navigate: () => {} }
export const useMutation = () => ({ mutate: () => {}, isPending: false })
export const usePluginI18n = () => (key, ...args) => \`<\${key}\${args.length ? ':' + args.join(',') : ''}>\`
export const useQuery = () => globalThis.__QUERY__ ?? { isPending: false, isError: false, data: null }
export const useQueryClient = () => ({ invalidateQueries: () => {} })
`
const reactStub = `export const useState = v => [typeof v === 'function' ? v() : v, () => {}]
export const useMemo = f => f()
export const useCallback = f => f
export const useEffect = () => {}
`
const jsxStub = `export const jsx = (type, props) => (typeof type === 'function' ? type(props ?? {}) : { type, props: props ?? {} })
export const jsxs = jsx
export const Fragment = Symbol('Fragment')
`

writeFileSync(join(OUT, 'sdk.mjs'), sdkStub)
writeFileSync(join(OUT, 'react.mjs'), reactStub)
writeFileSync(join(OUT, 'react-jsx-runtime.mjs'), jsxStub)

// ---- rewrite bare specifiers like the loader does -------------------------
let source = readFileSync(SRC, 'utf8')
source = source
  .replaceAll(`from '@hermes/plugin-sdk'`, `from '${pathToFileURL(join(OUT, 'sdk.mjs')).href}'`)
  .replaceAll(`from 'react/jsx-runtime'`, `from '${pathToFileURL(join(OUT, 'react-jsx-runtime.mjs')).href}'`)
  .replaceAll(`from 'react'`, `from '${pathToFileURL(join(OUT, 'react.mjs')).href}'`)
const rewritten = join(OUT, 'plugin.mjs')
writeFileSync(rewritten, `// rewritten for test\n${source}`)

const mod = await import(pathToFileURL(rewritten).href)
const plugin = mod.default

const fails = []
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra ? ` — ${extra}` : ''}`)
  if (!cond) fails.push(label)
}

check('default export has id', plugin && plugin.id === 'provider-copy', JSON.stringify(plugin && plugin.id))
check('name present', typeof plugin.name === 'string' && plugin.name.length > 0)
check('register is a function', typeof plugin.register === 'function')

// ---- register() with a recording ctx --------------------------------------
const contributions = []
const registeredI18n = []
const ctx = {
  registerMany: list => contributions.push(...list),
  storage: {},
  rest: async () => ({}),
  i18n: {
    register: bundles => {
      registeredI18n.push(bundles)
      return () => {}
    },
    t: key => `<<${key}>>`
  }
}
try {
  plugin.register(ctx)
  check('register() ran without throwing', true)
} catch (error) {
  check('register() ran without throwing', false, String(error))
}

check('registers 3 contributions', contributions.length === 3, String(contributions.length))
const areas = contributions.map(c => c.area).sort()
check(
  'areas: routes + sidebar-nav + palette',
  JSON.stringify(areas) === JSON.stringify(['palette', 'routes', 'sidebar-nav']),
  JSON.stringify(areas)
)
const route = contributions.find(c => c.area === 'routes')
check('route path is /provider-copy', route && route.data.path === '/provider-copy', JSON.stringify(route && route.data))
const nav = contributions.find(c => c.area === 'sidebar-nav')
check('nav path matches route', nav && nav.data.path === '/provider-copy', JSON.stringify(nav && nav.data))
check('nav codicon set', nav && typeof nav.data.codicon === 'string' && nav.data.codicon.length > 0)
const palette = contributions.find(c => c.area === 'palette')
check(
  'palette row has id+label+run',
  palette && palette.data.id && palette.data.label && typeof palette.data.run === 'function',
  JSON.stringify(palette && palette.data)
)

// ---- walk a rendered tree for element types -------------------------------
function collectTypes(node, found = []) {
  if (node == null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, found)
    return found
  }
  if (node.type) found.push(node.type)
  collectTypes(node.props && node.props.children, found)
  return found
}

function renderWith(query) {
  globalThis.__QUERY__ = query
  return collectTypes(route.render({}))
}

let types = renderWith({ isPending: true, isError: false, data: null, refetch: () => {} })
check('loading state renders EmptyState', types.includes('EmptyState'), types.join(','))

types = renderWith({ isPending: false, isError: true, error: new Error('boom'), data: null, refetch: () => {} })
check('error state renders EmptyState + Button', types.includes('EmptyState') && types.includes('Button'), types.join(','))

types = renderWith({
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: () => {},
  data: {
    source: 'default',
    profiles: [
      { name: 'default', label: 'default', is_default: true },
      { name: 'alpha', label: 'Alpha', is_default: false }
    ],
    keys: ['GLM_API_KEY', 'MINIMAX_API_KEY'],
    targets: [
      { name: 'alpha', label: 'Alpha', is_default: false, missing: ['MINIMAX_API_KEY'], present: ['GLM_API_KEY'], error: null }
    ]
  }
})
check(
  'data state renders Select + checkbox row + Badge + Button',
  types.includes('Select') && types.includes('Checkbox') && types.includes('Badge') && types.includes('Button'),
  types.join(',')
)
check('data state renders the key chips', types.includes('code'), types.join(','))

types = renderWith({
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: () => {},
  data: { source: 'alpha', profiles: [], keys: [], targets: [] }
})
check('no-keys state renders EmptyState', types.includes('EmptyState'), types.join(','))

// ---- every t('key') in source must exist in the en bundle -----------------
const en = (registeredI18n[0] || {}).en || {}
const missing = []
const seen = new Set()
for (const match of readFileSync(SRC, 'utf8').matchAll(/\bt\('([^']+)'/g)) {
  const key = match[1]
  if (seen.has(key)) continue
  seen.add(key)
  if (!(key in en)) missing.push(key)
}
check(`all ${seen.size} i18n keys present in en bundle`, missing.length === 0, missing.join(', '))
const extras = Object.keys(en).filter(k => !seen.has(k))
check('en bundle has no unused keys', extras.length === 0, extras.join(','))

console.log()
if (fails.length) {
  console.log(`${fails.length} FAILURES: ${fails.join(' | ')}`)
  process.exit(1)
}
console.log('ALL PASS')
