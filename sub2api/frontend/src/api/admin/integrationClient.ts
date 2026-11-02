import axios, { type AxiosRequestConfig } from 'axios'
import apiClient from '../client'

interface IntegrationEnvelope<T> {
  ok: boolean
  data?: T
  error?: { code?: string; message?: string; request_id?: string }
}

/** Uses the administrator session; the integration management secret stays on the server. */
export async function integrationRequest<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path) || path.split('/').includes('..')) {
    throw new Error('Invalid integration API path')
  }
  try {
    const response = await apiClient.request<IntegrationEnvelope<T>>({
      timeout: 120_000,
      ...config,
      url: `/admin/integration${path}`,
    })
    const envelope = response.data
    if (!envelope || envelope.ok !== true || !Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      throw {
        status: response.status,
        code: envelope?.error?.code || 'invalid_integration_response',
        message: envelope?.error?.message || 'Invalid integration API response',
        request_id: envelope?.error?.request_id,
      }
    }
    return envelope.data as T
  } catch (cause) {
    if (axios.isCancel(cause)) throw cause
    const error = cause as { status?: number; code?: string; message?: string; error?: IntegrationEnvelope<T>['error'] }
    // The shared client keeps HTTP error envelopes under `error`.
    if (error?.error && typeof error.error === 'object') {
      throw { ...error, code: error.error.code || error.code, message: error.error.message || error.message,
        request_id: error.error.request_id }
    }
    throw cause
  }
}

export function integrationErrorMessage(error: unknown, fallback: string): string {
  return typeof (error as { message?: unknown })?.message === 'string'
    ? (error as { message: string }).message : fallback
}
