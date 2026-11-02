import { useEffect, useState } from 'react'

/**
 * 30s 心跳时钟，驱动分钟精度的倒计时显示。
 * 半分钟一跳保证展示值与真值误差 < 1 分钟，又不至于让整棵表每秒重渲。
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
