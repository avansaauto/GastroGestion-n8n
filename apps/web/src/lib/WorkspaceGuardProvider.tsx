import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  IDLE_WORKSPACE_GUARD,
  resolveWorkspaceGuards,
  type WorkspaceGuardReport,
} from './workspaceGuard'

type WorkspaceGuardEntry = {
  id: string
  report: WorkspaceGuardReport
  discard: () => void
}

type WorkspaceGuardRegistry = {
  register: (entry: WorkspaceGuardEntry) => () => void
  evaluate: () => WorkspaceGuardReport
  discardAll: () => void
}

const WorkspaceGuardContext = createContext<WorkspaceGuardRegistry | null>(null)

export function WorkspaceGuardProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, WorkspaceGuardEntry>())
  const register = useCallback((entry: WorkspaceGuardEntry) => {
    entries.current.set(entry.id, entry)
    return () => {
      entries.current.delete(entry.id)
    }
  }, [])
  const evaluate = useCallback(() => (
    resolveWorkspaceGuards([...entries.current.values()].map((entry) => entry.report))
  ), [])
  const discardAll = useCallback(() => {
    for (const entry of entries.current.values()) entry.discard()
  }, [])
  const value = useMemo<WorkspaceGuardRegistry>(() => ({
    register,
    evaluate,
    discardAll,
  }), [discardAll, evaluate, register])

  return (
    <WorkspaceGuardContext.Provider value={value}>
      {children}
    </WorkspaceGuardContext.Provider>
  )
}

export function useRegisterWorkspaceGuard(
  id: string,
  report: WorkspaceGuardReport,
  discard: () => void,
) {
  const registry = useContext(WorkspaceGuardContext)
  const reportRef = useRef(report)
  const discardRef = useRef(discard)
  reportRef.current = report
  discardRef.current = discard
  useEffect(() => {
    if (!registry) return
    return registry.register({
      id,
      get report() { return reportRef.current },
      discard: () => discardRef.current(),
    })
  }, [id, registry])
}

export function useWorkspaceGuardRegistry() {
  const registry = useContext(WorkspaceGuardContext)
  if (!registry) {
    return {
      evaluate: () => IDLE_WORKSPACE_GUARD,
      discardAll: () => undefined,
      register: () => () => undefined,
    } satisfies WorkspaceGuardRegistry
  }
  return registry
}
