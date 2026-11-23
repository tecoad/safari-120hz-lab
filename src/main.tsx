// Single entry for the Vite app. Two routes, no .html pages:
//   /            the glass demo (reading indicator, contents menu, tab bar, meters)
//   /components  the reusable React components (scrubber, meter, sheet)
// Links between them are plain <a href> (a full load), so each page boots its
// engine on a clean slate. Vite serves index.html for any path in dev (SPA fallback).

import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { ComponentsDemo } from './demos/components/ComponentsDemo'
import { GlassDemo } from './demos/glass/GlassDemo'

const routes: Record<string, ComponentType> = {
  '/': GlassDemo,
  '/components': ComponentsDemo,
}

function NotFound() {
  return (
    <main className="prose-probe mx-auto max-w-[640px] px-5 pt-28">
      <h1>Not found</h1>
      <p>
        Try <a href="/">the glass demo</a> or <a href="/components">the React components</a>.
      </p>
    </main>
  )
}

const path = window.location.pathname.replace(/\/+$/, '') || '/'
const Page = routes[path] ?? NotFound

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
