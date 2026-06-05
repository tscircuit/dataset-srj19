import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const circuitsDir = path.join(repoRoot, "circuits")

const bgaPadComponentId = "bga_component"
const passiveFootprints = [
  { width: 0.5, height: 0.28 },
  { width: 0.62, height: 0.34 },
  { width: 0.78, height: 0.42 },
  { width: 0.42, height: 0.42 },
  { width: 0.34, height: 0.62 },
  { width: 0.28, height: 0.5 },
]

const isBgaPadObstacle = (obstacle) =>
  obstacle.obstacleId?.startsWith("pcb_smtpad_bga_pin_") ?? false

const getOppositeLayer = (layer) => (layer === "top" ? "bottom" : "top")

const getSampleIndex = (sampleName) => Number(sampleName.replace("sample", ""))

const createRng = (seed) => {
  let state = seed >>> 0

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const randomBetween = (rng, min, max) => min + rng() * (max - min)

const randomInt = (rng, min, max) =>
  Math.floor(randomBetween(rng, min, max + 1))

const pick = (rng, values) => values[randomInt(rng, 0, values.length - 1)]

const shuffle = (rng, values) => {
  const shuffled = [...values]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(rng, 0, index)
    ;[shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ]
  }

  return shuffled
}

const roundCoord = (value) => Number(value.toFixed(3))

const getRotatedRectLocalPoint = (rect, point) => {
  const rotationRadians = (-(rect.ccwRotationDegrees ?? 0) * Math.PI) / 180
  const dx = point.x - rect.center.x
  const dy = point.y - rect.center.y

  return {
    x: dx * Math.cos(rotationRadians) - dy * Math.sin(rotationRadians),
    y: dx * Math.sin(rotationRadians) + dy * Math.cos(rotationRadians),
  }
}

const rectContainsPoint = (rect, point, margin = 0) => {
  const localPoint = getRotatedRectLocalPoint(rect, point)

  return (
    Math.abs(localPoint.x) <= rect.width / 2 + margin &&
    Math.abs(localPoint.y) <= rect.height / 2 + margin
  )
}

const getConnectionPoints = (srj) =>
  (srj.connections ?? []).flatMap(
    (connection) => connection.pointsToConnect ?? [],
  )

const isClearOfConnectionPoints = (passiveObstacle, connectionPoints) =>
  connectionPoints.every(
    (point) => !rectContainsPoint(passiveObstacle, point, 0.08),
  )

const makePassiveObstacle = (rng, bgaPad, passiveIndex, passiveLayer) => {
  const passiveNumber = String(passiveIndex + 1).padStart(3, "0")
  const footprint = pick(rng, passiveFootprints)
  const centerOffset = {
    x: randomBetween(rng, -0.36, 0.36),
    y: randomBetween(rng, -0.36, 0.36),
  }
  const rotation = pick(rng, [0, 0, 0, 90, 90, 180, 270])

  return {
    obstacleId: `pcb_passive_overlay_${passiveNumber}`,
    type: "rect",
    layers: [passiveLayer],
    center: {
      x: roundCoord(bgaPad.center.x + centerOffset.x),
      y: roundCoord(bgaPad.center.y + centerOffset.y),
    },
    width: footprint.width,
    height: footprint.height,
    ...(rotation === 0 ? {} : { ccwRotationDegrees: rotation }),
    connectedTo: [],
    componentId: `passive_component_${passiveNumber}`,
  }
}

const makeClearPassiveObstacles = ({
  rng,
  bgaPads,
  passiveLayer,
  passiveCount,
  connectionPoints,
}) => {
  const passiveObstacles = []
  const candidateBgaPads = shuffle(rng, bgaPads)
  let candidateIndex = 0
  let attempts = 0

  while (
    passiveObstacles.length < passiveCount &&
    attempts < candidateBgaPads.length * 20
  ) {
    const bgaPad = candidateBgaPads[candidateIndex % candidateBgaPads.length]
    const candidate = makePassiveObstacle(
      rng,
      bgaPad,
      passiveObstacles.length,
      passiveLayer,
    )

    if (isClearOfConnectionPoints(candidate, connectionPoints)) {
      passiveObstacles.push(candidate)
    }

    candidateIndex += 1
    attempts += 1
  }

  return passiveObstacles
}

const setLayers = (srj, layer) => {
  for (const obstacle of srj.obstacles ?? []) {
    obstacle.layers = [layer]

    if (isBgaPadObstacle(obstacle)) {
      obstacle.componentId = bgaPadComponentId
    }
  }

  for (const connection of srj.connections ?? []) {
    for (const point of connection.pointsToConnect ?? []) {
      point.layer = layer
    }
  }
}

const stripExistingPassiveOverlay = (srj) => {
  srj.obstacles = (srj.obstacles ?? []).filter(
    (obstacle) =>
      !obstacle.obstacleId?.startsWith("pcb_passive_overlay_") &&
      !obstacle.componentId?.startsWith("passive_component_"),
  )
}

const transformSample = (srj, sampleName) => {
  stripExistingPassiveOverlay(srj)

  const sampleIndex = getSampleIndex(sampleName)
  const rng = createRng(sampleIndex * 2654435761)
  const bgaLayer = sampleIndex % 2 === 0 ? "top" : "bottom"
  const passiveLayer = getOppositeLayer(bgaLayer)

  setLayers(srj, bgaLayer)

  const bgaPads = srj.obstacles
    .filter(isBgaPadObstacle)
    .sort((a, b) =>
      a.center.y === b.center.y
        ? a.center.x - b.center.x
        : b.center.y - a.center.y,
    )

  const passiveCount = Math.max(
    4,
    Math.min(
      bgaPads.length - 1,
      Math.round(bgaPads.length * randomBetween(rng, 0.28, 0.58)),
    ),
  )
  const passiveObstacles = makeClearPassiveObstacles({
    rng,
    bgaPads,
    passiveLayer,
    passiveCount,
    connectionPoints: getConnectionPoints(srj),
  })

  srj.obstacles.push(...passiveObstacles)

  srj.metadata = {
    ...(srj.metadata ?? {}),
    bgaLayer,
    passiveLayer,
    passiveOverlayCount: passiveObstacles.length,
    passiveOverlayRule:
      "Passive component keepouts are placed as a deterministic random subset around the BGA footprint on the opposite PCB layer, with varied sizes, orientations, and offsets.",
  }

  return srj
}

const sampleNames = (await readdir(circuitsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => /^sample\d{3}$/.test(name))
  .sort()

for (const sampleName of sampleNames) {
  const sourcePath = path.join(
    circuitsDir,
    sampleName,
    `${sampleName}.circuit.simple-route.json`,
  )
  const srj = JSON.parse(await readFile(sourcePath, "utf8"))
  const transformedSrj = transformSample(srj, sampleName)

  await writeFile(sourcePath, `${JSON.stringify(transformedSrj, null, 2)}\n`)
}

console.log(`Generated passive overlays for ${sampleNames.length} samples.`)
