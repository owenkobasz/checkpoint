import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import { processScan } from './api/scan-manifest'
import type { ScanRequestBody } from './api/scan-manifest'

// Serves the scan endpoint under plain `npm run dev`, so local development
// doesn't require `vercel dev`. Production uses the real serverless function.
function scanApiPlugin(): Plugin {
  return {
    name: 'scan-manifest-dev-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/scan-manifest', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          void (async () => {
            let body: ScanRequestBody
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ScanRequestBody
            } catch {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ error: 'invalid JSON' }))
              return
            }
            const origin = Array.isArray(req.headers.origin)
              ? req.headers.origin[0]
              : req.headers.origin
            const outcome = await processScan(origin, body)
            res.statusCode = outcome.status
            res.setHeader('content-type', 'application/json')
            res.end(outcome.body)
          })()
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // ANTHROPIC_API_KEY has no VITE_ prefix, so Vite never exposes it to the
  // client — but the dev middleware above needs it in process.env.
  const env = loadEnv(mode, process.cwd(), '')
  if (env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
  }

  return {
    root: '.',
    build: { outDir: 'dist' },
    plugins: [scanApiPlugin()],
  }
})
