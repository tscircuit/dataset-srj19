import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getSimpleRouteJsonFromCircuitJson } from "@tscircuit/core"
import { runTscircuitCode } from "@tscircuit/eval"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const circuitsDir = path.join(repoRoot, "circuits")

const bgaPadComponentId = "bga_component"
const passiveFootprints = [
  { width: 0.5, height: 0.28, courtyardWidth: 2.4, courtyardHeight: 1.55 },
  { width: 0.62, height: 0.34, courtyardWidth: 2.8, courtyardHeight: 1.8 },
  { width: 0.78, height: 0.42, courtyardWidth: 3.25, courtyardHeight: 2.05 },
  { width: 0.42, height: 0.42, courtyardWidth: 2.1, courtyardHeight: 2.1 },
  { width: 0.34, height: 0.62, courtyardWidth: 1.8, courtyardHeight: 2.8 },
  { width: 0.28, height: 0.5, courtyardWidth: 1.55, courtyardHeight: 2.4 },
]

const isBgaPadObstacle = (obstacle) =>
  obstacle.obstacleId?.startsWith("pcb_smtpad_bga_pin_") ?? false

const getPassiveObstacles = (srj) =>
  srj.obstacles.filter((obstacle) =>
    obstacle.obstacleId?.startsWith("pcb_passive_overlay_"),
  )

const isGeneratedPassiveObstacle = (obstacle) =>
  obstacle.obstacleId?.startsWith("pcb_passive_overlay_") ||
  /^pcb_smtpad_[RC]\d+_pin[12]$/.test(obstacle.obstacleId ?? "") ||
  obstacle.componentId?.startsWith("passive_component_") ||
  /^[RC]\d+$/.test(obstacle.componentId ?? "")

const isBgaBreakoutConnection = (connection) => {
  const pointIds = (connection.pointsToConnect ?? []).map(
    (point) => point.pointId ?? "",
  )

  return (
    pointIds.length === 2 &&
    pointIds.some((pointId) => pointId.startsWith("bga_pin_")) &&
    pointIds.some((pointId) => pointId.startsWith("io_pin_"))
  )
}

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
    courtyardWidth: footprint.courtyardWidth,
    courtyardHeight: footprint.courtyardHeight,
    ...(rotation === 0 ? {} : { ccwRotationDegrees: rotation }),
    connectedTo: [],
    componentId: `passive_component_${passiveNumber}`,
  }
}

const getPassiveCourtyard = (passiveObstacle) => ({
  ...passiveObstacle,
  width: passiveObstacle.courtyardWidth ?? passiveObstacle.width,
  height: passiveObstacle.courtyardHeight ?? passiveObstacle.height,
})

const isClearOfPassiveObstacles = (candidate, passiveObstacles) =>
  passiveObstacles.every(
    (passiveObstacle) =>
      !rectsOverlap(
        getPassiveCourtyard(candidate),
        getPassiveCourtyard(passiveObstacle),
        0.45,
      ),
  )

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

    if (
      isClearOfConnectionPoints(candidate, connectionPoints) &&
      isClearOfPassiveObstacles(candidate, passiveObstacles)
    ) {
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
    (obstacle) => !isGeneratedPassiveObstacle(obstacle),
  )
  srj.connections = (srj.connections ?? []).filter(isBgaBreakoutConnection)
}

const formatMm = (value) => `${Number(value.toFixed(3))}mm`

const getPinNameFromPointId = (pointId) => pointId?.replace(/^(.+)_/, "pin")

const getPortNameFromObstacle = (obstacle) =>
  obstacle.connectedTo?.find((connection) =>
    connection.startsWith("pcb_port_"),
  )

const getPointByPortId = (srj, portId) =>
  getConnectionPoints(srj).find((point) => point.pcb_port_id === portId)

const getPadName = (srj, obstacle) => {
  const obstaclePinNumber = obstacle.obstacleId?.match(/pin_(\d+)$/)?.[1]
  if (obstaclePinNumber) return `pin${obstaclePinNumber}`

  const portId = getPortNameFromObstacle(obstacle)
  const point = getPointByPortId(srj, portId)

  if (point?.pointId) return getPinNameFromPointId(point.pointId)

  return "pin"
}

const getFootprintPadTsx = (srj, obstacle, portNameOverride) => {
  const portName = portNameOverride ?? getPadName(srj, obstacle)
  const rotation = obstacle.ccwRotationDegrees ?? 0

  return `        <smtpad
          portHints={["${portName}"]}
          pcbX="${formatMm(obstacle.center.x)}"
          pcbY="${formatMm(obstacle.center.y)}"
          width="${formatMm(obstacle.width)}"
          height="${formatMm(obstacle.height)}"
          shape="rect"
          layer="${obstacle.layers[0]}"
          ${rotation === 0 ? "" : `pcbRotation={${rotation}}`}
        />`
}

const getPassiveFootprintName = (passive) => {
  const longSide = Math.max(passive.width, passive.height)

  if (longSide <= 0.42) return "0201"
  if (longSide <= 0.5) return "0402"
  if (longSide <= 0.62) return "0603"
  return "0805"
}

const getPassiveComponentName = (passiveIndex) =>
  `${passiveIndex % 2 === 0 ? "R" : "C"}${String(passiveIndex + 1).padStart(3, "0")}`

const getPassiveTsx = (passive, passiveIndex) => {
  const componentName = getPassiveComponentName(passiveIndex)
  const commonProps = `name="${componentName}" footprint="${getPassiveFootprintName(passive)}" pcbX="${formatMm(passive.center.x)}" pcbY="${formatMm(passive.center.y)}" pcbRotation={${passive.ccwRotationDegrees ?? 0}} layer="${passive.layers[0]}" pcbPositionMode="relative_to_board_anchor"`

  if (passiveIndex % 2 === 0) {
    const resistanceValues = ["10k", "4.7k", "1k", "100"]
    return `      <resistor ${commonProps} resistance="${resistanceValues[passiveIndex % resistanceValues.length]}" />`
  }

  const capacitanceValues = ["100nF", "1uF", "10nF", "4.7uF"]
  return `      <capacitor ${commonProps} capacitance="${capacitanceValues[passiveIndex % capacitanceValues.length]}" />`
}

const getIoTestpointTsx = (srj, ioPad) => {
  const ioPinName = getPadName(srj, ioPad)
  const ioNumber = ioPinName.replace(/^pin/, "")
  const rotation = ioPad.ccwRotationDegrees ?? 0

  return `      <testpoint
        name="TP${ioNumber}"
        footprintVariant="pad"
        padShape="rect"
        pcbX="${formatMm(ioPad.center.x)}"
        pcbY="${formatMm(ioPad.center.y)}"
        width="${formatMm(ioPad.width)}"
        height="${formatMm(ioPad.height)}"
        layer="${ioPad.layers[0]}"
        ${rotation === 0 ? "" : `pcbRotation={${rotation}}`}
        pcbPositionMode="relative_to_board_anchor"
      />`
}

const getBreakoutTraceTsx = (srj, bgaPad, ioPad, bgaPortName) => {
  const ioNumber = getPadName(srj, ioPad).replace(/^pin/, "")

  return `      <trace from=".BGA > .${bgaPortName}" to=".TP${ioNumber} > .pin1" />`
}

const getDistance = (a, b) => Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)

const getNearestPad = (passive, pads, offset) =>
  [...pads]
    .sort((a, b) => getDistance(passive, a) - getDistance(passive, b))[offset % pads.length]

const getPassiveTraceTsx = ({
  srj,
  passive,
  passiveIndex,
  bgaPads,
  ioPads,
  bgaPadNameByObstacle,
}) => {
  const passiveComponentName = getPassiveComponentName(passiveIndex)
  const bgaPad = getNearestPad(passive, bgaPads, passiveIndex)
  const ioPad = getNearestPad(passive, ioPads, passiveIndex + 1)
  const bgaPortName = bgaPadNameByObstacle.get(bgaPad) ?? getPadName(srj, bgaPad)
  const ioNumber = getPadName(srj, ioPad).replace(/^pin/, "")

  return `      <trace from=".BGA > .${bgaPortName}" to=".${passiveComponentName} > .pin1" />
      <trace from=".${passiveComponentName} > .pin2" to=".TP${ioNumber} > .pin1" />`
}

const getBgaPinLabelsTsx = (bgaPads) =>
  `{${bgaPads
    .map((_, padIndex) => {
      const pinName = `pin${String(padIndex + 1).padStart(3, "0")}`
      return `${pinName}: "${pinName}"`
    })
    .join(", ")}}`

const createCircuitTsx = (srj, sampleName) => {
  const bgaPads = srj.obstacles
    .filter(isBgaPadObstacle)
    .sort((a, b) =>
      a.center.y === b.center.y
        ? a.center.x - b.center.x
        : b.center.y - a.center.y,
    )
  const ioPads = srj.obstacles
    .filter((obstacle) => obstacle.obstacleId?.startsWith("pcb_smtpad_io_"))
    .sort((a, b) => getPadName(srj, a).localeCompare(getPadName(srj, b)))
  const passiveObstacles = getPassiveObstacles(srj)
  const bgaPadNameByObstacle = new Map(
    bgaPads.map((pad, padIndex) => [
      pad,
      `pin${String(padIndex + 1).padStart(3, "0")}`,
    ]),
  )
  const ioPadByName = new Map(ioPads.map((pad) => [getPadName(srj, pad), pad]))
  const breakoutTraceTsx = bgaPads
    .map((bgaPad) => {
      const bgaPortName = bgaPadNameByObstacle.get(bgaPad) ?? getPadName(srj, bgaPad)
      const ioPad = ioPadByName.get(bgaPortName)
      return ioPad ? getBreakoutTraceTsx(srj, bgaPad, ioPad, bgaPortName) : null
    })
    .filter(Boolean)

  return `export default () => (
  <board width="${formatMm(srj.bounds.maxX - srj.bounds.minX)}" height="${formatMm(srj.bounds.maxY - srj.bounds.minY)}" routingDisabled schematicDisabled>
    <chip
      name="BGA"
      pcbX="0mm"
      pcbY="0mm"
      layer="${srj.metadata.bgaLayer}"
      pinLabels={${getBgaPinLabelsTsx(bgaPads)}}
      footprint={
        <footprint>
${bgaPads.map((pad) => getFootprintPadTsx(srj, pad, bgaPadNameByObstacle.get(pad))).join("\n")}
        </footprint>
      }
    />
${ioPads.map((pad) => getIoTestpointTsx(srj, pad)).join("\n")}
${breakoutTraceTsx.join("\n")}
${passiveObstacles.map(getPassiveTsx).join("\n")}
${passiveObstacles
  .map((passive, passiveIndex) =>
    getPassiveTraceTsx({
      srj,
      passive,
      passiveIndex,
      bgaPads,
      ioPads,
      bgaPadNameByObstacle,
    }),
  )
  .join("\n")}
  </board>
)
`
}

const createTsxSeedSrj = (srj, sampleName) => {
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
    1,
    Math.min(
      Math.ceil(bgaPads.length * 0.14),
      Math.round(bgaPads.length * randomBetween(rng, 0.05, 0.12)),
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
      "Passive components are placed as a deterministic random subset around the BGA footprint on the opposite PCB layer, with varied sizes, orientations, offsets, and routed connections.",
  }

  return srj
}

const getMapById = (circuitJson, type, idKey) =>
  new Map(
    circuitJson
      .filter((element) => element.type === type)
      .map((element) => [element[idKey], element]),
  )

const getPcbSmtpadIdFromObstacle = (obstacle) =>
  obstacle.connectedTo?.find((connection) => connection.startsWith("pcb_smtpad_"))

const padHintToPaddedNumber = (pad) => {
  const hint = pad?.port_hints?.find((value) => /^pin\d+$/.test(value))
  const number = hint?.replace(/^pin/, "") ?? String(pad?.pin_number ?? 0)
  return number.padStart(3, "0")
}

const getComponentInfoForPcbPort = ({
  pcbPortId,
  pcbPortById,
  sourcePortById,
  sourceComponentById,
}) => {
  const pcbPort = pcbPortById.get(pcbPortId)
  const sourcePort = sourcePortById.get(pcbPort?.source_port_id)
  const sourceComponent = sourceComponentById.get(sourcePort?.source_component_id)

  return { pcbPort, sourcePort, sourceComponent }
}

const normalizeSrjFromCircuitJson = ({
  circuitJson,
  simpleRouteJson,
  sampleName,
  bgaLayer,
  passiveLayer,
}) => {
  const pcbSmtpadById = getMapById(circuitJson, "pcb_smtpad", "pcb_smtpad_id")
  const pcbPortById = getMapById(circuitJson, "pcb_port", "pcb_port_id")
  const pcbComponentById = getMapById(
    circuitJson,
    "pcb_component",
    "pcb_component_id",
  )
  const sourcePortById = getMapById(
    circuitJson,
    "source_port",
    "source_port_id",
  )
  const sourceComponentById = getMapById(
    circuitJson,
    "source_component",
    "source_component_id",
  )

  let passivePadCount = 0
  const passiveComponentNames = new Set()

  for (const obstacle of simpleRouteJson.obstacles ?? []) {
    const pcbSmtpad = pcbSmtpadById.get(getPcbSmtpadIdFromObstacle(obstacle))
    const pcbComponent = pcbComponentById.get(pcbSmtpad?.pcb_component_id)
    const sourceComponent = sourceComponentById.get(
      pcbComponent?.source_component_id,
    )
    const sourcePort = sourcePortById.get(
      pcbPortById.get(pcbSmtpad?.pcb_port_id)?.source_port_id,
    )
    const sourceComponentName = sourceComponent?.name ?? "component"

    obstacle.connectedTo = Array.isArray(obstacle.connectedTo)
      ? obstacle.connectedTo
      : []

    if (sourceComponentName === "BGA") {
      const pinNumber = padHintToPaddedNumber(sourcePort)
      obstacle.obstacleId = `pcb_smtpad_bga_pin_${pinNumber}`
      obstacle.componentId = bgaPadComponentId
      obstacle.layers = [bgaLayer]
      continue
    }

    if (sourceComponentName.startsWith("TP")) {
      const ioNumber = sourceComponentName.replace(/^TP/, "").padStart(3, "0")
      obstacle.obstacleId = `pcb_smtpad_io_pin_${ioNumber}`
      obstacle.componentId = sourceComponentName
      obstacle.layers = [bgaLayer]
      continue
    }

    if (/^[RC]\d+$/.test(sourceComponentName)) {
      const pinNumber = sourcePort?.name ?? `pin${(passivePadCount % 2) + 1}`
      obstacle.obstacleId = `pcb_smtpad_${sourceComponentName}_${pinNumber}`
      obstacle.componentId = sourceComponentName
      obstacle.layers = [passiveLayer]
      passiveComponentNames.add(sourceComponentName)
      passivePadCount += 1
    }
  }

  for (const [connectionIndex, connection] of (
    simpleRouteJson.connections ?? []
  ).entries()) {
    const connectionNumber = String(connectionIndex + 1).padStart(3, "0")
    const connectsPassive = (connection.pointsToConnect ?? []).some((point) => {
      const { sourceComponent } = getComponentInfoForPcbPort({
        pcbPortId: point.pcb_port_id,
        pcbPortById,
        sourcePortById,
        sourceComponentById,
      })
      return /^[RC]\d+$/.test(sourceComponent?.name ?? "")
    })
    connection.name = `${connectsPassive ? "passive_conn" : "bga_conn"}_${connectionNumber}`
    connection.rootConnectionName = connection.name

    for (const point of connection.pointsToConnect ?? []) {
      const { sourcePort, sourceComponent } = getComponentInfoForPcbPort({
        pcbPortId: point.pcb_port_id,
        pcbPortById,
        sourcePortById,
        sourceComponentById,
      })

      if (sourceComponent?.name === "BGA") {
        const pinNumber = padHintToPaddedNumber(sourcePort)
        point.layer = bgaLayer
        point.pointId = `bga_pin_${pinNumber}`
      } else if (sourceComponent?.name?.startsWith("TP")) {
        const ioNumber = sourceComponent.name.replace(/^TP/, "").padStart(3, "0")
        point.layer = bgaLayer
        point.pointId = `io_pin_${ioNumber}`
      } else if (/^[RC]\d+$/.test(sourceComponent?.name ?? "")) {
        point.layer = passiveLayer
        point.pointId = `${sourceComponent.name}_${sourcePort?.name ?? "pin"}`
      }
    }
  }

  simpleRouteJson.metadata = {
    ...(simpleRouteJson.metadata ?? {}),
    sampleName,
    bgaLayer,
    passiveLayer,
    passiveComponentCount: passiveComponentNames.size,
    passiveOverlayCount: passivePadCount,
    generatedFrom: "tsx-circuit-json-core-simple-route",
    passiveOverlayRule:
      "Passive components are generated in TSX as real routed resistors/capacitors, rendered to circuit JSON with tscircuit, then converted to simple-route JSON using @tscircuit/core.",
  }

  return simpleRouteJson
}

const getSimpleRouteJsonFromTsx = async ({
  circuitTsx,
  sampleName,
  bgaLayer,
  passiveLayer,
}) => {
  const circuitJson = await runTscircuitCode(circuitTsx, { name: sampleName })
  const { simpleRouteJson } = getSimpleRouteJsonFromCircuitJson({
    circuitJson,
    minTraceWidth: 0.15,
    nominalTraceWidth: 0.15,
  })

  return normalizeSrjFromCircuitJson({
    circuitJson,
    simpleRouteJson,
    sampleName,
    bgaLayer,
    passiveLayer,
  })
}

const sampleNames = (await readdir(circuitsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => /^sample\d{3}$/.test(name))
  .sort()

for (const [sampleIndex, sampleName] of sampleNames.entries()) {
  const sourcePath = path.join(
    circuitsDir,
    sampleName,
    `${sampleName}.circuit.simple-route.json`,
  )
  const circuitPath = path.join(circuitsDir, sampleName, `${sampleName}.circuit.tsx`)
  const srj = JSON.parse(await readFile(sourcePath, "utf8"))
  const tsxSeedSrj = createTsxSeedSrj(srj, sampleName)
  const circuitTsx = createCircuitTsx(tsxSeedSrj, sampleName)
  const transformedSrj = await getSimpleRouteJsonFromTsx({
    circuitTsx,
    sampleName,
    bgaLayer: tsxSeedSrj.metadata.bgaLayer,
    passiveLayer: tsxSeedSrj.metadata.passiveLayer,
  })

  await writeFile(sourcePath, `${JSON.stringify(transformedSrj, null, 2)}\n`)
  await writeFile(circuitPath, circuitTsx)

  if ((sampleIndex + 1) % 25 === 0 || sampleIndex === sampleNames.length - 1) {
    console.log(`Generated ${sampleIndex + 1}/${sampleNames.length} samples...`)
  }
}

console.log(
  `Generated TSX circuits, circuit JSON, and core-derived SRJ for ${sampleNames.length} samples.`,
)
process.exit(0)
