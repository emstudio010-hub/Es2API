import fs from 'node:fs'
import path from 'node:path'

// A local supervisor acknowledgement, not an OS or supplier attestation.
// Legacy empty markers and malformed receipts are intentionally unconfirmed.
export function readCodexCliExitReceipt(dir, nonce = null) {
  try {
    const requestId = path.basename(dir)
    if (!/^req-[a-f0-9-]+$/.test(requestId)) return null
    const target = path.join(dir, 'done')
    const info = fs.lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 2048) return null
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    let bytes
    try {
      const opened = fs.fstatSync(descriptor)
      if (!opened.isFile() || opened.size !== info.size || opened.dev !== info.dev || opened.ino !== info.ino) return null
      bytes = Buffer.alloc(2049)
      const size = fs.readSync(descriptor, bytes, 0, bytes.length, 0)
      if (size < 2 || size > 2048) return null
      bytes = bytes.subarray(0, size)
    } finally { fs.closeSync(descriptor) }
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!receipt || receipt.format !== 'es2api-cli-exit-v1' || receipt.request_id !== requestId ||
      !/^[a-f0-9]{64}$/.test(receipt.nonce || '') || (nonce !== null && receipt.nonce !== nonce) ||
      receipt.live_group_members !== 0 || !Number.isInteger(receipt.exit_code) || receipt.exit_code < 0 || receipt.exit_code > 255) return null
    if (receipt.phase === 'not_started') {
      return receipt.exit_code === 126 && receipt.pid === null && receipt.pgid === null ? receipt : null
    }
    if (receipt.phase !== 'exited' || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 || receipt.pgid !== receipt.pid) return null
    return receipt
  } catch { return null }
}

// Docker closing the host pipe is insufficient. Give a flushed bind-mount
// receipt a bounded chance to become visible, including after cancellation.
export async function waitCodexCliExitReceipt(dir, nonce, timeoutMs = 2000) {
  const until = Date.now() + Math.max(0, Math.min(2000, Number(timeoutMs) || 0))
  for (;;) {
    const receipt = readCodexCliExitReceipt(dir, nonce)
    if (receipt || Date.now() >= until) return receipt
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
