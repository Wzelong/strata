import { Header } from './components/header'
import { Dashboard } from './components/dashboard'

export function App() {
  return (
    <div className="h-dvh flex flex-col">
      <Header />
      <main className="flex-1 min-h-0 h-0 pt-10">
        <Dashboard />
      </main>
    </div>
  )
}
