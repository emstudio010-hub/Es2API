import fs from 'node:fs'
import crypto from 'node:crypto'
import { decodeDetector } from '../resources/modeltrace/cpa-v2/detector-codec.mjs'
import { analyzeSharedOutputs, supportsSharedDetector } from '../resources/modeltrace/cpa-v2/shared-detector.mjs'

const root = new URL('../resources/modeltrace/cpa-v2/', import.meta.url)
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'))
for (const [name, { sha256 }] of Object.entries(manifest.files)) {
  const bytes = fs.readFileSync(new URL(name, root))
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`ModelTrace pinned artifact checksum mismatch: ${name}`)
}
const bank = JSON.parse(fs.readFileSync(new URL('models.json', root), 'utf8'))
const detector = decodeDetector(fs.readFileSync(new URL('shared_detector.bin', root)))
if (!supportsSharedDetector(bank, detector)) throw new Error('ModelTrace detector and model bank do not match')
const suite = JSON.parse(fs.readFileSync(new URL('enrollment-suite.json', root), 'utf8'))
const aliases = Object.freeze({ 'gpt-6.1-sol': 'gpt-6-astra', 'deepseek-flash': 'deepseek-v4.1-flash-1017' })
const revision = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

export function numberFingerprintBank() {
  return {
    ready: true,
    source: `cpa-codex-candy-eval@${manifest.cpa_revision}`,
    method: 'shared-detector-v2',
    revision,
    built_at: bank.built_at,
    calibrated_samples: 3,
    challenges: suite.map(item => ({ id: item.challenge_id, expected_count: item.expected_count,
      condition: item.condition, instructions: item.system || '',
      prompt: item.user_prefix ? `${item.user_prefix}\n\nFinal task:\n${item.prompt}` : item.prompt })),
    models: bank.models.map(model => model.id),
    aliases: { ...aliases },
    detector_sha256: manifest.files['shared_detector.bin'].sha256,
  }
}

export function compareNumberFingerprint(samples, expectedModel, threshold = 0.8) {
  const expectedCandidate = aliases[expectedModel] || expectedModel
  const result = analyzeSharedOutputs(samples, bank, detector, { allowPartial: true })
  const known = bank.models.some(model => model.id === expectedCandidate)
  const status = !known ? 'unlisted_model' : result.used_outputs < 3 ? 'insufficient_samples'
    : result.decision === 'not_model' || !Number.isFinite(result.probability) || result.probability < threshold ? 'inconclusive'
      : result.prediction === expectedCandidate ? 'match' : 'suspected_mismatch'
  return {
    ...result,
    status,
    expected_model: expectedModel,
    expected_candidate: expectedCandidate,
    confidence: result.probability,
    actionable: status === 'suspected_mismatch',
    bank_revision: revision,
    detector_sha256: manifest.files['shared_detector.bin'].sha256,
    scores: result.results.map(row => ({ model: row.model, score: row.probability, samples: result.used_outputs })),
  }
}
