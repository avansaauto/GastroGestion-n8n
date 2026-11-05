import { useEffect, useState } from 'react'
import { getLocations, getOrganizations, type Location, type Organization } from '@/lib/api'
import { useAuth } from '@/lib/auth'

export function organizationName(organization: Organization) {
  return organization.name || organization.nombre || organization.id
}

export function locationName(location: Location) {
  return location.name || location.nombre || location.id
}

/** Alcance local por página. El alcance operativo compartido está en AuthorizedScopeProvider. */
export function useAuthorizedScope() {
  const { previewMode } = useAuth()
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [organizationId, setOrganizationId] = useState('')
  const [locations, setLocations] = useState<Location[]>([])
  const [locationId, setLocationId] = useState('')
  const [loading, setLoading] = useState(!previewMode)
  const [error, setError] = useState('')

  useEffect(() => {
    if (previewMode) return
    setLoading(true)
    getOrganizations()
      .then((data) => {
        setOrganizations(data)
        setOrganizationId((current) => current || data[0]?.id || '')
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false))
  }, [previewMode])

  useEffect(() => {
    if (!organizationId) {
      setLocations([])
      setLocationId('')
      return
    }
    setLoading(true)
    setError('')
    getLocations(organizationId)
      .then((data) => {
        setLocations(data)
        setLocationId((current) => (
          data.some((location) => location.id === current) ? current : data[0]?.id || ''
        ))
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false))
  }, [organizationId])

  return {
    previewMode,
    organizations,
    organizationId,
    setOrganizationId,
    locations,
    locationId,
    setLocationId,
    loading,
    error,
  }
}
