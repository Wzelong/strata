import { useRef, useMemo, useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { CodeUnitNode, ClusterColorMap, GraphHighlight } from '../../types/graph'

const LERP_SPEED = 4
const FADE_DURATION = 0.1
const MAX_INSTANCES = 4096

interface NodeTarget {
  x: number
  y: number
  z: number
  scale: number
  r: number
  g: number
  b: number
}

function computeTargets(
  nodes: CodeUnitNode[],
  clusterColors: ClusterColorMap,
  isDark: boolean,
  highlight: GraphHighlight | null,
): NodeTarget[] {
  const orphan = new THREE.Color(isDark ? '#94a3b8' : '#64748b')
  const dimColor = new THREE.Color(isDark ? '#525252' : '#a1a1aa')
  const tc = new THREE.Color()
  const baseScale = isDark ? 0.25 : 0.27
  // Dark mode glows via HDR bloom: push active node colors above 1.0 so they clear
  // the bloom's ~1.0 luminance threshold. Dim/inactive nodes stay LDR and don't glow.
  const glow = isDark ? 1.8 : 1

  return nodes.map(n => {
    const clusterColor = n.cluster_label ? clusterColors.get(n.cluster_label) : undefined
    if (clusterColor) tc.set(clusterColor)
    else tc.copy(orphan)

    const active = !highlight || highlight.nodeIds.has(n.id)
    const r = active ? tc.r * glow : dimColor.r
    const g = active ? tc.g * glow : dimColor.g
    const b = active ? tc.b * glow : dimColor.b
    const sizeMul = highlight && !active ? 0.6 : 1
    const scale = baseScale * (0.85 + Math.min(1, n.hub_score) * 0.5) * sizeMul

    return { x: n.x3d, y: n.y3d, z: n.z3d, scale, r, g, b }
  })
}

export function NodeCloud({
  nodes, clusterColors, isDark, highlight, onNodeClick, bgColor, tCurrent,
}: {
  nodes: CodeUnitNode[]
  clusterColors: ClusterColorMap
  isDark: boolean
  highlight: GraphHighlight | null
  onNodeClick?: (nodeId: string) => void
  bgColor: string
  tCurrent: number
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const pointerDownRef = useRef(0)
  const [hovered, setHovered] = useState(false)
  const tempObj = useMemo(() => new THREE.Object3D(), [])
  const tempColor = useMemo(() => new THREE.Color(), [])
  const bg = useMemo(() => new THREE.Color(bgColor), [bgColor])

  useEffect(() => {
    if (onNodeClick) document.body.style.cursor = hovered ? 'pointer' : 'default'
    return () => { document.body.style.cursor = 'default' }
  }, [hovered, onNodeClick])

  const currentPos = useRef(new Float32Array(MAX_INSTANCES * 3))
  const currentCol = useRef(new Float32Array(MAX_INSTANCES * 3))
  const currentScale = useRef(new Float32Array(MAX_INSTANCES))
  const currentAlpha = useRef(new Float32Array(MAX_INSTANCES))
  const nodeIndexMap = useRef(new Map<string, number>())
  const activeCount = useRef(0)

  const targets = useMemo(
    () => computeTargets(nodes, clusterColors, isDark, highlight),
    [nodes, clusterColors, isDark, highlight],
  )

  useMemo(() => {
    const prevMap = nodeIndexMap.current
    const prevPos = currentPos.current
    const prevCol = currentCol.current
    const prevScale = currentScale.current
    const prevAlpha = currentAlpha.current
    const nextMap = new Map<string, number>()

    const newPos = new Float32Array(MAX_INSTANCES * 3)
    const newCol = new Float32Array(MAX_INSTANCES * 3)
    const newScale = new Float32Array(MAX_INSTANCES)
    const newAlpha = new Float32Array(MAX_INSTANCES)

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      nextMap.set(n.qualname, i)
      const prevIdx = prevMap.get(n.qualname)
      const tgt = targets[i]

      if (prevIdx !== undefined && prevIdx < activeCount.current) {
        newPos[i * 3] = prevPos[prevIdx * 3]
        newPos[i * 3 + 1] = prevPos[prevIdx * 3 + 1]
        newPos[i * 3 + 2] = prevPos[prevIdx * 3 + 2]
        newCol[i * 3] = prevCol[prevIdx * 3]
        newCol[i * 3 + 1] = prevCol[prevIdx * 3 + 1]
        newCol[i * 3 + 2] = prevCol[prevIdx * 3 + 2]
        newScale[i] = prevScale[prevIdx]
        newAlpha[i] = prevAlpha[prevIdx]
      } else {
        newPos[i * 3] = tgt.x
        newPos[i * 3 + 1] = tgt.y
        newPos[i * 3 + 2] = tgt.z
        newCol[i * 3] = tgt.r
        newCol[i * 3 + 1] = tgt.g
        newCol[i * 3 + 2] = tgt.b
        newScale[i] = tgt.scale
        newAlpha[i] = 0
      }
    }

    currentPos.current = newPos
    currentCol.current = newCol
    currentScale.current = newScale
    currentAlpha.current = newAlpha
    nodeIndexMap.current = nextMap
    activeCount.current = nodes.length
  }, [nodes])

  useFrame((_, delta) => {
    if (!meshRef.current || nodes.length === 0) return
    const pos = currentPos.current
    const col = currentCol.current
    const scl = currentScale.current
    const alpha = currentAlpha.current
    const t = Math.min(1, delta * LERP_SPEED)
    const alphaStep = delta / FADE_DURATION

    for (let i = 0; i < nodes.length; i++) {
      const tgt = targets[i]
      const node = nodes[i]
      const targetAlpha = node.created_at == null || node.created_at <= tCurrent ? 1 : 0

      pos[i * 3] += (tgt.x - pos[i * 3]) * t
      pos[i * 3 + 1] += (tgt.y - pos[i * 3 + 1]) * t
      pos[i * 3 + 2] += (tgt.z - pos[i * 3 + 2]) * t
      col[i * 3] += (tgt.r - col[i * 3]) * t
      col[i * 3 + 1] += (tgt.g - col[i * 3 + 1]) * t
      col[i * 3 + 2] += (tgt.b - col[i * 3 + 2]) * t
      scl[i] += (tgt.scale - scl[i]) * t

      const a = alpha[i]
      if (a < targetAlpha) alpha[i] = Math.min(targetAlpha, a + alphaStep)
      else if (a > targetAlpha) alpha[i] = Math.max(targetAlpha, a - alphaStep)
      const av = alpha[i]

      tempObj.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      // Scale by visibility too — a time-hidden node (av→0) must collapse to nothing,
      // not just fade to the background color, or its full-size sphere keeps occluding
      // visible nodes (near-black "zombie" spheres in dark mode) and still raycasts.
      tempObj.scale.setScalar(scl[i] * av)
      tempObj.updateMatrix()
      meshRef.current.setMatrixAt(i, tempObj.matrix)

      tempColor.setRGB(
        bg.r + (col[i * 3] - bg.r) * av,
        bg.g + (col[i * 3 + 1] - bg.g) * av,
        bg.b + (col[i * 3 + 2] - bg.b) * av,
      )
      meshRef.current.setColorAt(i, tempColor)
    }

    for (let i = nodes.length; i < MAX_INSTANCES; i++) {
      tempObj.scale.setScalar(0)
      tempObj.updateMatrix()
      meshRef.current.setMatrixAt(i, tempObj.matrix)
    }

    meshRef.current.instanceMatrix.needsUpdate = true
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MAX_INSTANCES]}
      frustumCulled={false}
      onPointerDown={() => { pointerDownRef.current = Date.now() }}
      onPointerUp={(e) => {
        if (!onNodeClick) return
        if (Date.now() - pointerDownRef.current > 200) return
        const idx = e.instanceId
        if (idx !== undefined && idx < nodes.length) {
          const node = nodes[idx]
          if (node.created_at != null && node.created_at > tCurrent) return
          e.stopPropagation()
          onNodeClick(node.id)
        }
      }}
      onPointerOver={() => { if (onNodeClick) setHovered(true) }}
      onPointerOut={() => { setHovered(false) }}
    >
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}
