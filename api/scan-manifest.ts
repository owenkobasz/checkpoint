import Anthropic from '@anthropic-ai/sdk'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// Vercel rejects request bodies over 4.5 MB at the platform level — enforce a
// lower app-level cap so oversize uploads get a clear 400, not a 413. This
// measures the base64 string (~1.33× the binary size → ~3 MB of image).
const MAX_IMAGE_CHARS = 4 * 1024 * 1024
const MAX_HINT_CHARS = 120

const ALLOWED_ORIGINS = new Set([
  'https://checkpoint.bike',
  'https://www.checkpoint.bike',
  'http://localhost:5173',
  'http://localhost:3000',
])

// Deterrent only: blocks other sites' browsers from hotlinking the endpoint.
// Scripted callers omit Origin and pass — the spend cap covers those.
function originAllowed(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || origin.endsWith('.vercel.app')
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['city', 'checkpoints'],
  properties: {
    city: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'City or neighborhood the manifest is for, if printed or clearly inferable. Null otherwise.',
    },
    checkpoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'note', 'confidence'],
        properties: {
          name: {
            type: 'string',
            description:
              'The checkpoint location, phrased for a geocoder: an intersection ("Broad & Girard"), street address, or named place. Strip list numbering, point values, and task text.',
          },
          note: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Task or instructions at this checkpoint, if any. Null otherwise.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'low'],
            description:
              'low if the text is hard to read, ambiguous, or you had to guess at characters.',
          },
        },
      },
    },
  },
}

const PROMPT = `This is a photo of an alleycat bike race manifest: a list of
checkpoints ("controls") racers must visit. Extract every checkpoint location.

- Locations are usually intersections, addresses, or named places/businesses.
- Ignore headers, rules, sponsor logos, point values, and the start/finish
  lines if labeled as such — extract checkpoints only.
- Keep task instructions (e.g. "take a selfie", "get manifest signed") in the
  note field, not in the name.
- Do not invent checkpoints. If a line is illegible, either omit it or return
  your best reading with confidence "low".`

export interface ScanRequestBody {
  image?: string
  mediaType?: string
  hint?: string
}

export interface ScanOutcome {
  status: number
  body: string
}

function jsonError(status: number, error: string): ScanOutcome {
  return { status, body: JSON.stringify({ error }) }
}

export async function processScan(
  origin: string | undefined,
  body: ScanRequestBody
): Promise<ScanOutcome> {
  if (origin && !originAllowed(origin)) {
    return jsonError(403, 'forbidden')
  }

  const { image, mediaType, hint } = body
  if (
    typeof image !== 'string' ||
    image.length === 0 ||
    image.length > MAX_IMAGE_CHARS ||
    mediaType !== 'image/jpeg'
  ) {
    return jsonError(400, 'bad image payload')
  }
  const safeHint = typeof hint === 'string' ? hint.slice(0, MAX_HINT_CHARS) : null

  const started = Date.now()
  try {
    const client = new Anthropic()

    const response = await client.beta.messages.create({
      model: 'claude-opus-5',
      // thinking is on by default on claude-opus-5 and shares this cap with
      // the JSON output — 8192 leaves room for both on a dense manifest
      max_tokens: 8192,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: image },
            },
            {
              type: 'text',
              text: safeHint ? `${PROMPT}\n\nContext: the race is near "${safeHint}".` : PROMPT,
            },
          ],
        },
      ],
    })

    if (response.stop_reason === 'refusal') {
      return jsonError(502, 'scan declined')
    }
    if (response.stop_reason === 'max_tokens') {
      return jsonError(502, 'scan output truncated')
    }

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    const result = JSON.parse(text) as { checkpoints?: { length: number } }

    console.log(
      JSON.stringify({
        event: 'scan',
        imageChars: image.length,
        checkpoints: result.checkpoints?.length ?? 0,
        latencyMs: Date.now() - started,
        model: response.model,
      })
    )

    return { status: 200, body: text }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'scan_error',
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : 'unknown',
      })
    )
    return jsonError(502, 'scan failed')
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }

  const outcome = await processScan(req.headers.origin, (req.body ?? {}) as ScanRequestBody)
  res.status(outcome.status).setHeader('content-type', 'application/json').send(outcome.body)
}
