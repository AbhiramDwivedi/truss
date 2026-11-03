// The Run tabs (ADR-0023 section 4): a tablist named Run with Crews, Decisions and ADRs, and Design. App owns
// the selected tab; this view only lays out the tablist and the panel it is given for each tab.
import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx'

export type RunTab = 'crews' | 'decisions' | 'design'

export interface RunTabsProps {
  tab: RunTab
  onTab: (tab: RunTab) => void
  crews: ReactNode
  decisions: ReactNode
  design: ReactNode
}

const TABS: { value: RunTab; label: string }[] = [
  { value: 'crews', label: 'Crews' },
  { value: 'decisions', label: 'Decisions and ADRs' },
  { value: 'design', label: 'Design' },
]

const isTab = (v: string): v is RunTab => TABS.some((t) => t.value === v)

export function RunTabs({ tab, onTab, crews, decisions, design }: RunTabsProps) {
  const panels: Record<RunTab, ReactNode> = { crews, decisions, design }
  return (
    <Tabs value={tab} onValueChange={(v) => { if (isTab(v)) onTab(v) }} activationMode="automatic">
      <TabsList aria-label="Run">
        {TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {TABS.map((t) => (
        <TabsContent key={t.value} value={t.value} className="flex min-w-0 flex-col gap-6">
          {panels[t.value]}
        </TabsContent>
      ))}
    </Tabs>
  )
}
