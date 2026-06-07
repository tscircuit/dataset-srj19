import { convertSrjToGraphicsObject } from "@tscircuit/capacity-autorouter"
import { drawGraphicsToCanvas, type GraphicsObject } from "graphics-debug"
import {
  type ChangeEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Matrix } from "transformation-matrix"
import manifest from "../dataset-dist/manifest.json"

type SimpleRouteJson = Parameters<typeof convertSrjToGraphicsObject>[0]
type SrjObstacle = SimpleRouteJson["obstacles"][number] & {
  componentId?: string
}
type PartialSimpleRouteJson = Partial<SimpleRouteJson> & {
  obstacles?: SimpleRouteJson["obstacles"]
  connections?: SimpleRouteJson["connections"]
}

const SAMPLE_HASH_PARAM = "sample"

const clampSampleIndex = (sampleIndex: number) =>
  Math.min(
    Math.max(Number.isFinite(sampleIndex) ? sampleIndex : 0, 0),
    manifest.sampleCount - 1,
  )

const getSampleIndexFromHash = () => {
  if (typeof window === "undefined") return 0

  const hashParams = new URLSearchParams(window.location.hash.slice(1))
  const sampleNumber = Number(hashParams.get(SAMPLE_HASH_PARAM))

  if (!Number.isFinite(sampleNumber)) return 0
  return clampSampleIndex(sampleNumber - 1)
}

const setSampleIndexInHash = (sampleIndex: number) => {
  if (typeof window === "undefined") return

  const url = new URL(window.location.href)
  const hashParams = new URLSearchParams(url.hash.slice(1))
  hashParams.set(SAMPLE_HASH_PARAM, String(sampleIndex + 1))
  url.hash = hashParams.toString()

  window.history.replaceState(window.history.state, "", url)
}

const isBgaPadObstacle = (obstacle: SrjObstacle) =>
  obstacle.obstacleId?.startsWith("pcb_smtpad_bga_pin_") ?? false

const rectKey = (obstacle: {
  center?: { x: number; y: number }
  width?: number
  height?: number
}) =>
  `${obstacle.center?.x ?? ""}:${obstacle.center?.y ?? ""}:${
    obstacle.width ?? ""
  }:${obstacle.height ?? ""}`

const getObstacleLabel = (obstacle: SrjObstacle) =>
  [
    obstacle.obstacleId,
    `type: ${obstacle.type}`,
    obstacle.componentId ? `componentId: ${obstacle.componentId}` : null,
    obstacle.connectedTo?.length
      ? `connectedTo: ${obstacle.connectedTo.join(", ")}`
      : null,
    obstacle.layers?.length ? `layers: ${obstacle.layers.join(", ")}` : null,
    obstacle.center
      ? `center: (${obstacle.center.x}, ${obstacle.center.y})`
      : null,
    "width" in obstacle && "height" in obstacle
      ? `size: ${obstacle.width} x ${obstacle.height}`
      : null,
  ]
    .filter(Boolean)
    .join("\n")

const normalizeSimpleRouteJson = (
  srj: PartialSimpleRouteJson,
): SimpleRouteJson =>
  ({
    ...srj,
    obstacles: (srj.obstacles ?? []).map((obstacle) => ({
      ...obstacle,
      connectedTo: obstacle.connectedTo ?? [],
      layers: obstacle.layers ?? [],
    })),
    connections: srj.connections ?? [],
  }) as SimpleRouteJson

const expandBoundsWithPoint = (
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  point: { x: number; y: number },
) => {
  bounds.minX = Math.min(bounds.minX, point.x)
  bounds.minY = Math.min(bounds.minY, point.y)
  bounds.maxX = Math.max(bounds.maxX, point.x)
  bounds.maxY = Math.max(bounds.maxY, point.y)
}

const getGraphicsMaxAbsCoordinate = (graphics: GraphicsObject) => {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }

  for (const point of graphics.points ?? []) {
    expandBoundsWithPoint(bounds, point)
  }

  for (const line of graphics.lines ?? []) {
    for (const point of line.points) {
      expandBoundsWithPoint(bounds, point)
    }
  }

  for (const polygon of graphics.polygons ?? []) {
    for (const point of polygon.points) {
      expandBoundsWithPoint(bounds, point)
    }
  }

  for (const arrow of graphics.arrows ?? []) {
    expandBoundsWithPoint(bounds, arrow.start)
    expandBoundsWithPoint(bounds, arrow.end)
  }

  for (const rect of graphics.rects ?? []) {
    expandBoundsWithPoint(bounds, {
      x: rect.center.x - rect.width / 2,
      y: rect.center.y - rect.height / 2,
    })
    expandBoundsWithPoint(bounds, {
      x: rect.center.x + rect.width / 2,
      y: rect.center.y + rect.height / 2,
    })
  }

  for (const circle of graphics.circles ?? []) {
    expandBoundsWithPoint(bounds, {
      x: circle.center.x - circle.radius,
      y: circle.center.y - circle.radius,
    })
    expandBoundsWithPoint(bounds, {
      x: circle.center.x + circle.radius,
      y: circle.center.y + circle.radius,
    })
  }

  for (const text of graphics.texts ?? []) {
    expandBoundsWithPoint(bounds, text)
  }

  if (!Number.isFinite(bounds.minX)) return 1

  return Math.max(
    Math.abs(bounds.minX),
    Math.abs(bounds.minY),
    Math.abs(bounds.maxX),
    Math.abs(bounds.maxY),
    1,
  )
}

const centerGraphicsOnOrigin = (graphics: GraphicsObject): GraphicsObject => {
  const maxAbsCoordinate = getGraphicsMaxAbsCoordinate(graphics)

  return {
    ...graphics,
    rects: [
      ...(graphics.rects ?? []),
      {
        center: { x: -maxAbsCoordinate, y: -maxAbsCoordinate },
        width: 0,
        height: 0,
        fill: "rgba(0,0,0,0)",
        stroke: "rgba(0,0,0,0)",
      },
      {
        center: { x: maxAbsCoordinate, y: maxAbsCoordinate },
        width: 0,
        height: 0,
        fill: "rgba(0,0,0,0)",
        stroke: "rgba(0,0,0,0)",
      },
    ],
  }
}

const getNiceGridStep = (scale: number) => {
  const targetScreenSpacing = 80
  const rawStep = targetScreenSpacing / scale
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude

  if (normalized <= 1) return magnitude
  if (normalized <= 2) return magnitude * 2
  if (normalized <= 5) return magnitude * 5
  return magnitude * 10
}

const worldToScreen = (matrix: Matrix, point: { x: number; y: number }) => ({
  x: matrix.a * point.x + matrix.e,
  y: matrix.d * point.y + matrix.f,
})

const screenToWorld = (matrix: Matrix, point: { x: number; y: number }) => ({
  x: (point.x - matrix.e) / matrix.a,
  y: (point.y - matrix.f) / matrix.d,
})

const drawGrid = (
  context: CanvasRenderingContext2D,
  transform: Matrix,
  width: number,
  height: number,
) => {
  const scale = Math.abs(transform.a)
  const step = getNiceGridStep(scale)
  const topLeft = screenToWorld(transform, { x: 0, y: 0 })
  const bottomRight = screenToWorld(transform, { x: width, y: height })
  const minX = Math.min(topLeft.x, bottomRight.x)
  const maxX = Math.max(topLeft.x, bottomRight.x)
  const minY = Math.min(topLeft.y, bottomRight.y)
  const maxY = Math.max(topLeft.y, bottomRight.y)
  const origin = worldToScreen(transform, { x: 0, y: 0 })

  context.save()
  context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace"
  context.textBaseline = "middle"

  context.strokeStyle = "#e2e8f0"
  context.lineWidth = 1
  context.beginPath()

  for (let x = Math.floor(minX / step) * step; x <= maxX; x += step) {
    const screen = worldToScreen(transform, { x, y: 0 })
    context.moveTo(screen.x, 0)
    context.lineTo(screen.x, height)
  }

  for (let y = Math.floor(minY / step) * step; y <= maxY; y += step) {
    const screen = worldToScreen(transform, { x: 0, y })
    context.moveTo(0, screen.y)
    context.lineTo(width, screen.y)
  }

  context.stroke()

  context.strokeStyle = "#64748b"
  context.lineWidth = 1.5
  context.beginPath()
  context.moveTo(0, origin.y)
  context.lineTo(width, origin.y)
  context.moveTo(origin.x, 0)
  context.lineTo(origin.x, height)
  context.stroke()

  context.fillStyle = "#0f172a"
  context.fillText(
    "0,0",
    Math.min(origin.x + 6, width - 30),
    Math.max(12, origin.y - 12),
  )
  context.restore()
}

const getDistanceToSegment = (
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  )
  const projection = {
    x: start.x + t * dx,
    y: start.y + t * dy,
  }

  return Math.hypot(point.x - projection.x, point.y - projection.y)
}

const getObjectLabelAtPoint = (
  graphics: GraphicsObject,
  transform: Matrix,
  screenPoint: { x: number; y: number },
) => {
  const hitSlop = 8

  for (const rect of [...(graphics.rects ?? [])].reverse()) {
    if (!rect.label) continue

    const center = worldToScreen(transform, rect.center)
    const halfWidth = Math.max((rect.width * Math.abs(transform.a)) / 2, hitSlop)
    const halfHeight = Math.max((rect.height * Math.abs(transform.d)) / 2, hitSlop)

    if (
      Math.abs(screenPoint.x - center.x) <= halfWidth &&
      Math.abs(screenPoint.y - center.y) <= halfHeight
    ) {
      return rect.label
    }
  }

  for (const circle of [...(graphics.circles ?? [])].reverse()) {
    if (!circle.label) continue

    const center = worldToScreen(transform, circle.center)
    const radius = Math.max(circle.radius * Math.abs(transform.a), hitSlop)

    if (Math.hypot(screenPoint.x - center.x, screenPoint.y - center.y) <= radius) {
      return circle.label
    }
  }

  for (const point of [...(graphics.points ?? [])].reverse()) {
    if (!point.label) continue

    const center = worldToScreen(transform, point)

    if (Math.hypot(screenPoint.x - center.x, screenPoint.y - center.y) <= hitSlop) {
      return point.label
    }
  }

  for (const line of [...(graphics.lines ?? [])].reverse()) {
    if (!line.label) continue

    const points = line.points.map((point) => worldToScreen(transform, point))
    for (let index = 0; index < points.length - 1; index += 1) {
      if (
        getDistanceToSegment(screenPoint, points[index], points[index + 1]) <=
        hitSlop
      ) {
        return line.label
      }
    }
  }

  return null
}

function GraphicsDebugViewer({ graphics }: { graphics: GraphicsObject }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [transform, setTransform] = useState<Matrix | null>(null)
  const [hover, setHover] = useState<{
    label: string
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateSize = () => {
      const nextWidth = Math.max(1, container.clientWidth)
      const nextHeight = Math.max(1, container.clientHeight)
      setSize({ width: nextWidth, height: nextHeight })
    }

    updateSize()
    const resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    const maxAbsCoordinate = getGraphicsMaxAbsCoordinate(graphics)
    const scale =
      Math.min(size.width, size.height) / Math.max(maxAbsCoordinate * 2.4, 1)

    setTransform({
      a: scale,
      b: 0,
      c: 0,
      d: -scale,
      e: size.width / 2,
      f: size.height / 2,
    })
  }, [graphics, size.height, size.width])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !transform) return

    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext("2d")
    if (!context) return

    context.clearRect(0, 0, size.width, size.height)
    drawGraphicsToCanvas(graphics, canvas, {
      disableLabels: true,
      hideInlineLabels: true,
      transform,
    })
    drawGrid(context, transform, size.width, size.height)
  }, [graphics, size.height, size.width, transform])

  const getCanvasPoint = (event: {
    clientX: number
    clientY: number
    currentTarget: HTMLCanvasElement
  }) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    }
  }

  const handleWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    if (!transform) return

    const point = getCanvasPoint(event)
    const worldPoint = screenToWorld(transform, point)
    const zoom = event.deltaY < 0 ? 1.15 : 1 / 1.15
    const nextScale = Math.max(0.01, Math.min(Math.abs(transform.a) * zoom, 500))

    setTransform({
      ...transform,
      a: nextScale,
      d: -nextScale,
      e: point.x - worldPoint.x * nextScale,
      f: point.y + worldPoint.y * nextScale,
    })
  }

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!transform) return

    const point = getCanvasPoint(event)
    if (dragRef.current) {
      const dx = point.x - dragRef.current.x
      const dy = point.y - dragRef.current.y
      dragRef.current = point
      setTransform((current) =>
        current
          ? {
              ...current,
              e: current.e + dx,
              f: current.f + dy,
            }
          : current,
      )
      return
    }

    const label = getObjectLabelAtPoint(graphics, transform, point)
    setHover(label ? { label, ...point } : null)
  }

  return (
    <div
      ref={containerRef}
      style={{ height: "100%", position: "relative", width: "100%" }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={(event) => {
          dragRef.current = getCanvasPoint(event)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          dragRef.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerLeave={() => {
          dragRef.current = null
          setHover(null)
        }}
        onWheel={handleWheel}
        style={{
          background: "#fff",
          cursor: dragRef.current ? "grabbing" : "grab",
          height: "100%",
          width: "100%",
        }}
      />
      {hover ? (
        <div
          style={{
            background: "#0f172a",
            borderRadius: 4,
            color: "#fff",
            fontSize: 12,
            left: hover.x,
            maxWidth: 360,
            padding: "6px 8px",
            pointerEvents: "none",
            position: "absolute",
            top: hover.y - 10,
            transform: "translate(-50%, -100%)",
            whiteSpace: "pre-wrap",
            zIndex: 10,
          }}
        >
          {hover.label}
        </div>
      ) : null}
    </div>
  )
}

const getGraphicsForSrj = (srj: SimpleRouteJson): GraphicsObject => {
  const labelsByRectKey = new Map<string, string[]>()

  for (const obstacle of srj.obstacles as SrjObstacle[]) {
    if (obstacle.type !== "rect") continue

    const key = rectKey(obstacle)
    const labels = labelsByRectKey.get(key) ?? []
    labels.push(getObstacleLabel(obstacle))
    labelsByRectKey.set(key, labels)
  }

  const graphics = convertSrjToGraphicsObject(srj)

  return centerGraphicsOnOrigin({
    ...graphics,
    rects: graphics.rects?.map((rect) => {
      const labels = labelsByRectKey.get(rectKey(rect))
      const obstacleLabel = labels?.shift()

      return {
        ...rect,
        label: [rect.label, obstacleLabel].filter(Boolean).join("\n\n"),
      }
    }),
  })
}

export default function DatasetPage() {
  const [selectedSampleIndex, setSelectedSampleIndex] = useState(
    getSampleIndexFromHash,
  )
  const [selectedSample, setSelectedSample] = useState<SimpleRouteJson | null>(
    null,
  )
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const syncSelectedSampleFromHash = () => {
      setSelectedSampleIndex(getSampleIndexFromHash())
    }

    window.addEventListener("hashchange", syncSelectedSampleFromHash)
    return () =>
      window.removeEventListener("hashchange", syncSelectedSampleFromHash)
  }, [])

  useEffect(() => {
    setSampleIndexInHash(selectedSampleIndex)
  }, [selectedSampleIndex])

  const selectedSampleMeta =
    manifest.samples[selectedSampleIndex] ?? manifest.samples[0]

  useEffect(() => {
    let cancelled = false

    async function loadSample() {
      setLoadError(null)
      setSelectedSample(null)

      try {
        const response = await fetch(`/${selectedSampleMeta.sourceFile}`)
        if (!response.ok) {
          throw new Error(`Failed to load sample (${response.status})`)
        }

        const srj = normalizeSimpleRouteJson(await response.json())
        if (!cancelled) {
          setSelectedSample(srj)
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load sample",
          )
        }
      }
    }

    loadSample()

    return () => {
      cancelled = true
    }
  }, [selectedSampleMeta.sourceFile])

  const graphicsResult = useMemo(() => {
    if (!selectedSample) return { error: null, graphics: null }

    try {
      return { error: null, graphics: getGraphicsForSrj(selectedSample) }
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to render sample graphics",
        graphics: null,
      }
    }
  }, [selectedSample])
  const graphics = graphicsResult.graphics
  const graphicsError = graphicsResult.error

  const bgaComponentIds = useMemo(() => {
    if (!selectedSample) return []

    return Array.from(
      new Set(
        (selectedSample.obstacles ?? [])
          .filter((obstacle) =>
            obstacle.obstacleId?.startsWith("pcb_smtpad_bga_pin_"),
          )
          .map((obstacle) => (obstacle as { componentId?: string }).componentId),
      ),
    )
  }, [selectedSample])

  return (
    <div
      style={{
        background: "#f1f5f9",
        color: "#0f172a",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        height: "100vh",
        padding: 12,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "#fff",
          border: "1px solid #cbd5e1",
          borderRadius: 4,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          padding: 12,
        }}
      >
        <label
          style={{
            alignItems: "center",
            display: "flex",
            fontSize: 14,
            gap: 8,
          }}
        >
          <span style={{ fontWeight: 600 }}>Sample</span>
          <input
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 4,
              padding: "4px 8px",
              width: 96,
            }}
            type="number"
            min={1}
            max={manifest.sampleCount}
            value={selectedSampleIndex + 1}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setSelectedSampleIndex(
                clampSampleIndex(Number(event.currentTarget.value) - 1),
              )
            }}
          />
        </label>
        <button
          disabled={selectedSampleIndex === 0}
          onClick={() =>
            setSelectedSampleIndex((index) => Math.max(index - 1, 0))
          }
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            fontSize: 14,
            opacity: selectedSampleIndex === 0 ? 0.5 : 1,
            padding: "4px 12px",
          }}
          type="button"
        >
          Previous
        </button>
        <button
          disabled={selectedSampleIndex === manifest.sampleCount - 1}
          onClick={() =>
            setSelectedSampleIndex((index) =>
              Math.min(index + 1, manifest.sampleCount - 1),
            )
          }
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            fontSize: 14,
            opacity: selectedSampleIndex === manifest.sampleCount - 1 ? 0.5 : 1,
            padding: "4px 12px",
          }}
          type="button"
        >
          Next
        </button>
        <div style={{ color: "#334155", fontSize: 14 }}>
          {selectedSampleMeta.sampleName} •{" "}
          {selectedSample?.connections.length ?? "..."} connections •{" "}
          {selectedSample?.obstacles.length ?? "..."} obstacles • BGA component
          IDs: {bgaComponentIds.join(", ") || "..."}
        </div>
      </div>
      <div
        style={{
          background: "#fff",
          border: "1px solid #cbd5e1",
          borderRadius: 4,
          flex: "1 1 0",
          minHeight: 0,
          overflow: "hidden",
          padding: 8,
        }}
      >
        {loadError || graphicsError ? (
          <div style={{ color: "#b91c1c", fontSize: 14, padding: 16 }}>
            {loadError ?? graphicsError}
          </div>
        ) : graphics ? (
          <GraphicsDebugViewer
            key={selectedSampleMeta.sampleName}
            graphics={graphics}
          />
        ) : (
          <div style={{ color: "#334155", fontSize: 14, padding: 16 }}>
            Loading {selectedSampleMeta.sampleName}...
          </div>
        )}
      </div>
    </div>
  )
}
