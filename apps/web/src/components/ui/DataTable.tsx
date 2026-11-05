import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface Column<Row> {
  key: string
  label: string
  render: (row: Row) => ReactNode
  className?: string
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  empty?: ReactNode
}) {
  if (rows.length === 0 && empty) return <>{empty}</>

  return (
    <div className="gg-table-wrap">
      <table className="gg-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th className={column.className} key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td className={cn(column.className)} key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
