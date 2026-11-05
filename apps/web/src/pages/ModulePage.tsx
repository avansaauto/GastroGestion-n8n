import type { LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { DataTable, type Column } from '@/components/ui/DataTable'

interface DemoRow {
  name: string
  detail: string
  status: string
}

export interface ModulePageProps {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  icon: LucideIcon
  demoRows?: DemoRow[]
  notice?: string
}

const columns: Column<DemoRow>[] = [
  { key: 'name', label: 'Elemento', render: (row) => <span className="font-semibold">{row.name}</span> },
  { key: 'detail', label: 'Detalle', render: (row) => <span className="text-senda-muted">{row.detail}</span> },
  { key: 'status', label: 'Estado', render: (row) => <Badge tone="neutral">{row.status}</Badge> },
]

export function ModulePage({
  title,
  description,
  emptyTitle,
  emptyDescription,
  icon: Icon,
  demoRows,
  notice,
}: ModulePageProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="m-0 text-2xl font-extrabold tracking-tight">{title}</h2>
          <p className="mb-0 mt-2 text-sm text-senda-muted">{description}</p>
        </div>
        {notice ? <Badge tone="success">{notice}</Badge> : null}
      </div>

      <Card className="overflow-hidden">
        {demoRows ? (
          <DataTable columns={columns} rows={demoRows} rowKey={(row) => row.name} />
        ) : (
          <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center">
            <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted"><Icon size={30} /></span>
            <h3 className="mb-0 mt-5 text-lg font-bold">{emptyTitle}</h3>
            <p className="mb-0 mt-2 max-w-md text-sm leading-6 text-senda-muted">{emptyDescription}</p>
          </div>
        )}
      </Card>
    </div>
  )
}
