import test from 'node:test'
import assert from 'node:assert/strict'
import { materializeRemoteImageSources } from '../../src/lib/protocol/images.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('materializeRemoteImageSources fetches url images to base64', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/example.com\/a.png$/)
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG,
    }
  }
  const out = await materializeRemoteImageSources(
    {
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是什么?' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
    },
    { fetchImpl },
  )
  assert.equal(out.messages[0].content[1].source.type, 'base64')
  assert.equal(out.messages[0].content[1].source.media_type, 'image/png')
  assert.equal(out.messages[0].content[1].source.data, PNG.toString('base64'))
})

test('materializeRemoteImageSources keeps url when fetch fails', async () => {
  const out = await materializeRemoteImageSources(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/missing.png' } }],
        },
      ],
    },
    {
      fetchImpl: async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
    },
  )
  assert.equal(out.messages[0].content[0].source.type, 'url')
})
