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

const getPassiveObstacles = (srj) =>
  srj.obstacles.filter((obstacle) =>
    obstacle.obstacleId?.startsWith("pcb_passive_overlay_"),
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

  if (obstacle.obstacleId?.startsWith("pcb_passive_overlay_")) {
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

    expect(passiveObstacles.length).toBeLessThan(bgaPads.length)
    expect(srj.metadata.bgaLayer).not.toBe(srj.metadata.passiveLayer)
    expect(sizeKeys.size).toBeGreaterThan(1)

    for (const passive of passiveObstacles) {
      expect(Array.isArray(passive.connectedTo)).toBe(true)
      expect(passive.layers).toEqual([srj.metadata.passiveLayer])
      expect(
        connectionPoints.some((point) => rectContainsPoint(passive, point)),
      ).toBe(false)
    }
  }
})
