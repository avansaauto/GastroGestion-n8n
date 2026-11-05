import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { useAuth } from '@/lib/auth'

export function LoginPage() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError(await signIn(email, password))
    setLoading(false)
  }

  return (
    <main className="grid min-h-screen place-items-center bg-senda-canvas px-5">
      <Card className="w-full max-w-md p-7">
        <div className="mb-7 flex items-center gap-3">
          <img
            alt="GastroGest"
            className="h-11 w-11 rounded-xl object-contain"
            height={44}
            src="/Gastrogest_logo.png"
            width={44}
          />
          <div>
            <p className="m-0 text-lg font-extrabold tracking-tight">GastroGest</p>
            <p className="m-0 text-sm text-senda-muted">Operaciones gastronómicas</p>
          </div>
        </div>
        <h1 className="text-2xl font-bold">Ingresar</h1>
        <p className="mt-2 text-sm text-senda-muted">Accedé con tu usuario de GastroGest.</p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <Input type="email" required placeholder="correo@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input type="password" required placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button className="w-full" disabled={loading} type="submit">
            {loading ? 'Ingresando…' : 'Ingresar'}
          </Button>
        </form>
      </Card>
    </main>
  )
}
