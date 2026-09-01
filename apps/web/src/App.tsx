import { motion } from 'motion/react'
import { useRoute } from '@/lib/router'
import { Nav } from '@/ui/Nav'
import { Landing } from '@/scenes/Landing'
import { Models } from '@/scenes/Models'
import { Chat } from '@/scenes/Chat'
import { Advisor } from '@/scenes/Advisor'
import { Fleet } from '@/scenes/Fleet'

export function App() {
  const route = useRoute()

  return (
    <div className="min-h-dvh">
      {route !== 'home' && <Nav />}
      {/*
        Deliberately not an AnimatePresence cross-fade. Scenes contain their own
        AnimatePresence blocks, and a nested one with pending children stops the
        parent's exit from ever completing — which strands the outgoing scene on
        screen. Each scene animates itself in on mount instead; `key` guarantees
        a fresh mount per route.
      */}
      <motion.div
        key={route}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        {route === 'home' && <Landing />}
        {route === 'models' && <Models />}
        {route === 'chat' && <Chat />}
        {route === 'advisor' && <Advisor />}
        {route === 'fleet' && <Fleet />}
      </motion.div>
    </div>
  )
}
