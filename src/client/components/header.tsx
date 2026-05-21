import { Moon, Sun, Settings, Trash2 } from 'lucide-react'
import { useTheme } from '../hooks/use-theme'
import logo from '../assets/logo.png'

export function Header() {
  const { theme, toggle } = useTheme()

  return (
    <header className="fixed top-0 left-0 right-0 h-10 border-t border-b border-border bg-background/95 backdrop-blur flex items-center z-50">
      <div className="pl-[6px] flex items-center gap-1">
        <img
          src={logo}
          alt="Strata"
          width={28}
          height={28}
          className="size-[28px]"
        />
        <span className="font-semibold text-sm">Strata</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1 pr-3">
        <button
          onClick={toggle}
          className="cursor-pointer h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-accent transition-colors"
        >
          {theme === 'dark' ? (
            <Moon className="size-3.5" />
          ) : (
            <Sun className="size-3.5" />
          )}
        </button>
        <button className="cursor-pointer h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-accent transition-colors">
          <Settings className="size-3.5" />
        </button>
        <button className="cursor-pointer h-7 w-7 inline-flex items-center justify-center rounded-md hover:text-destructive hover:bg-accent transition-colors">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </header>
  )
}
