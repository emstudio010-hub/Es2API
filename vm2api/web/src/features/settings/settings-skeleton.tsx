import { SectionSkeleton } from '@/components/page-skeletons'

/**
 * QueryGate 包的是右侧内容列。分组子导航是静态配置、在 gate 外真实渲染，
 * 骨架只需要占住内容卡的形状。
 */
export function SettingsSkeleton() {
  return <SectionSkeleton titleWidth='w-16' showDescription={false} rows={5} />
}
