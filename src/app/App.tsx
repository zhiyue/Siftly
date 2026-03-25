import Nav from './components/nav'
import CommandPalette from './components/command-palette'
import AppRoutes from './routes'

export default function App() {
  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100 antialiased">
      <Nav />
      <main className="flex-1 min-w-0 overflow-auto">
        <AppRoutes />
      </main>
      <CommandPalette />
    </div>
  )
}
