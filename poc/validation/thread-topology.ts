import { createRng, spreadTimestamps } from './util.js'

export type ThreadDef = {
  id: string
  topic: string
  commentSlots: number
}

export const NEUTRAL_THREADS: ThreadDef[] = [
  { id: 't3_post_01', topic: 'Best doorbell cameras under $100?', commentSlots: 18 },
  { id: 't3_post_02', topic: 'Is the Riverside Park path safe at night?', commentSlots: 15 },
  { id: 't3_post_03', topic: 'Car break-ins on the east side — anyone else?', commentSlots: 20 },
  { id: 't3_post_04', topic: 'Emergency preparedness kit recommendations', commentSlots: 12 },
  { id: 't3_post_05', topic: 'New streetlights on Oak Boulevard — making a difference?', commentSlots: 14 },
  { id: 't3_post_06', topic: 'Bike theft downtown — lock recommendations', commentSlots: 16 },
  { id: 't3_post_07', topic: 'Neighborhood watch vs Ring community — which works better?', commentSlots: 18 },
  { id: 't3_post_08', topic: 'What to do if you witness a break-in in progress', commentSlots: 12 },
  { id: 't3_post_09', topic: 'Has anyone used the city\'s free home security assessment?', commentSlots: 10 },
  { id: 't3_post_10', topic: 'Traffic calming measures — speed bumps vs roundabouts', commentSlots: 15 },
]

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export function computeTimeline() {
  const baseTime = Date.now() - THIRTY_DAYS_MS
  const rng = createRng(123)

  // Neutral thread posts spaced across days 1-26
  const threadPostTimes = spreadTimestamps(baseTime, NEUTRAL_THREADS.length, 26 * 24 * 60 * 60 * 1000)

  // Case posts at days 10, 18, 24
  const casePostTimes = {
    't3_case_a': baseTime + 10 * 24 * 60 * 60 * 1000,
    't3_case_b': baseTime + 18 * 24 * 60 * 60 * 1000,
    't3_case_c': baseTime + 24 * 24 * 60 * 60 * 1000,
  }

  // For each thread, comments span 0-48 hours after the post
  function commentTimesForThread(postTime: number, count: number): number[] {
    const windowMs = 48 * 60 * 60 * 1000
    const step = windowMs / (count + 1)
    return Array.from({ length: count }, (_, i) => {
      const jitter = rng() * step * 0.4
      return Math.floor(postTime + step * (i + 1) + jitter)
    })
  }

  // Connection items: placed 1-3 days after their case post
  function connectionTime(casePostTime: number): number {
    return casePostTime + Math.floor((0.5 + rng() * 2.5) * 24 * 60 * 60 * 1000)
  }

  return {
    baseTime,
    threadPostTimes,
    casePostTimes,
    commentTimesForThread,
    connectionTime,
  }
}
