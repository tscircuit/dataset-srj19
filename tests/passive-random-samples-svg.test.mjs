import "bun-match-svg"
import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { readFileSync } from "node:fs"
import path from "node:path"

const sampleNames = [
  "sample001",
  "sample014",
  "sample027",
  "sample052",
  "sample079",
  "sample103",
  "sample126",
  "sample151",
  "sample178",
  "sample200",
]

const getSampleSrj = (sampleName) =>
  JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "circuits",
        sampleName,
        `${sampleName}.circuit.simple-route.json`,
      ),
      "utf8",
    ),
  )

const getRotatedRectLocalPoint = (rect, point) => {
  const rotationRadians = (-(rect.ccwRotationDegrees ?? 0) * Math.PI) / 180
  const dx = point.x - rect.center.x
  const dy = point.y - rect.center.y

  return {
    x: dx * Math.cos(rotationRadians) - dy * Math.sin(rotationRadians),
    y: dx * Math.sin(rotationRadians) + dy * Math.cos(rotationRadians),
  }
}

const rectContainsPoint = (rect, point, margin = 0.08) => {
  const localPoint = getRotatedRectLocalPoint(rect, point)

  return (
    Math.abs(localPoint.x) <= rect.width / 2 + margin &&
    Math.abs(localPoint.y) <= rect.height / 2 + margin
  )
}

const getRectCorners = (rect, margin = 0) => {
  const rotationRadians = ((rect.ccwRotationDegrees ?? 0) * Math.PI) / 180
  const cos = Math.cos(rotationRadians)
  const sin = Math.sin(rotationRadians)
  const halfWidth = rect.width / 2 + margin
  const halfHeight = rect.height / 2 + margin

  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((point) => ({
    x: rect.center.x + point.x * cos - point.y * sin,
    y: rect.center.y + point.x * sin + point.y * cos,
  }))
}

const getSeparatingAxes = (corners) => [
  {
    x: corners[1].x - corners[0].x,
    y: corners[1].y - corners[0].y,
  },
  {
    x: corners[3].x - corners[0].x,
    y: corners[3].y - corners[0].y,
  },
].map((axis) => {
  const length = Math.hypot(axis.x, axis.y)
  return { x: -axis.y / length, y: axis.x / length }
})

const getProjection = (corners, axis) => {
  const values = corners.map((corner) => corner.x * axis.x + corner.y * axis.y)
  return { min: Math.min(...values), max: Math.max(...values) }
}

const rectsOverlap = (a, b, margin = 0) => {
  const aCorners = getRectCorners(a, margin)
  const bCorners = getRectCorners(b, margin)
  const axes = [...getSeparatingAxes(aCorners), ...getSeparatingAxes(bCorners)]

  return axes.every((axis) => {
    const aProjection = getProjection(aCorners, axis)
    const bProjection = getProjection(bCorners, axis)
    return (
      aProjection.max >= bProjection.min && bProjection.max >= aProjection.min
    )
  })
}

const getPassiveObstacles = (srj) =>
  srj.obstacles.filter((obstacle) =>
    /^pcb_smtpad_[RC]\d+_pin[12]$/.test(obstacle.obstacleId ?? ""),
  )

const getBgaPads = (srj) =>
  srj.obstacles.filter((obstacle) =>
    obstacle.obstacleId?.startsWith("pcb_smtpad_bga_pin_"),
  )

const getConnectionPoints = (srj) =>
  srj.connections.flatMap((connection) => connection.pointsToConnect)

const getObstacleStyle = (obstacle) => {
  if (obstacle.obstacleId?.startsWith("pcb_smtpad_bga_pin_")) {
    return {
      fill: "rgba(37, 99, 235, 0.62)",
      stroke: "#1d4ed8",
      label: "BGA",
    }
  }

  if (/^pcb_smtpad_[RC]\d+_pin[12]$/.test(obstacle.obstacleId ?? "")) {
    return {
      fill: "rgba(245, 158, 11, 0.72)",
      stroke: "#92400e",
      label: "PASSIVE",
    }
  }

  return {
    fill: "rgba(20, 184, 166, 0.55)",
    stroke: "#0f766e",
    label: "IO",
  }
}

const createSampleGraphics = (srj) => {
  const boardCenter = {
    x: (srj.bounds.minX + srj.bounds.maxX) / 2,
    y: (srj.bounds.minY + srj.bounds.maxY) / 2,
  }

  return {
    rects: [
      {
        center: boardCenter,
        width: srj.bounds.maxX - srj.bounds.minX,
        height: srj.bounds.maxY - srj.bounds.minY,
        fill: "rgba(255,255,255,0)",
        stroke: "#64748b",
        label: "board",
      },
      ...srj.obstacles
        .map((obstacle) => ({
          center: obstacle.center,
          width: obstacle.width,
          height: obstacle.height,
          ccwRotationDegrees: obstacle.ccwRotationDegrees,
          ...getObstacleStyle(obstacle),
        })),
    ],
    texts: [
      {
        x: boardCenter.x,
        y: srj.bounds.maxY + (srj.bounds.maxY - srj.bounds.minY) * 0.08,
        text: `BGA ${srj.metadata.bgaLayer} / passives ${srj.metadata.passiveLayer}`,
        anchorSide: "bottom_center",
        color: "#334155",
        fontSize: (srj.bounds.maxX - srj.bounds.minX) * 0.055,
      },
    ],
  }
}

test("passive random samples render to individual svg snapshots", () => {
  for (const sampleName of sampleNames) {
    const srj = getSampleSrj(sampleName)
    const svg = getSvgFromGraphicsObject(
      createSampleGraphics(srj),
      {
        backgroundColor: "white",
        includeTextLabels: false,
        svgWidth: 480,
        svgHeight: 480,
      },
    )

    expect(svg).toMatchSvgSnapshot(import.meta.path, sampleName)
  }
})

test("passive random samples stay router-compatible", () => {
  for (const sampleName of sampleNames) {
    const srj = getSampleSrj(sampleName)
    const bgaPads = getBgaPads(srj)
    const passiveObstacles = getPassiveObstacles(srj)
    const connectionPoints = getConnectionPoints(srj)
    const sizeKeys = new Set(
      passiveObstacles.map((obstacle) => `${obstacle.width}x${obstacle.height}`),
    )
    const passiveComponentCount = new Set(
      passiveObstacles.map((obstacle) => obstacle.componentId),
    ).size

    expect(passiveComponentCount).toBeLessThanOrEqual(
      Math.ceil(bgaPads.length * 0.1),
    )
    expect(srj.metadata.bgaLayer).not.toBe(srj.metadata.passiveLayer)
    if (passiveComponentCount > 2) {
      expect(sizeKeys.size).toBeGreaterThan(1)
    }

    for (const passive of passiveObstacles) {
      expect(Array.isArray(passive.connectedTo)).toBe(true)
      expect(passive.layers).toEqual([srj.metadata.passiveLayer])
      expect(
        connectionPoints
          .filter((point) => point.layer === passive.layers[0])
          .some((point) => rectContainsPoint(passive, point)),
      ).toBe(false)

      for (const otherPassive of passiveObstacles) {
        if (passive.componentId === otherPassive.componentId) continue
        expect(rectsOverlap(passive, otherPassive, 0.02)).toBe(false)
      }
    }
  }
})
