import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const circuitsDir = path.join(repoRoot, "circuits")
const datasetDistDir = path.join(repoRoot, "dataset-dist")
const bgaPadComponentId = "bga_component"

function addBgaPadComponentIds(srj) {
  let changed = false

  for (const obstacle of srj.obstacles ?? []) {
    if (
      obstacle.obstacleId?.startsWith("pcb_smtpad_bga_pin_") &&
      obstacle.componentId !== bgaPadComponentId
    ) {
      obstacle.componentId = bgaPadComponentId
      changed = true
    }
  }

  return changed
}

async function getSamples() {
  const sampleNames = (await readdir(circuitsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^sample\d{3}$/.test(name))
    .sort()

  return Promise.all(
    sampleNames.map(async (sampleName) => {
      const sourceFile = `circuits/${sampleName}/${sampleName}.circuit.simple-route.json`
      const sourcePath = path.join(repoRoot, sourceFile)
      const srj = JSON.parse(await readFile(sourcePath, "utf8"))

      if (addBgaPadComponentIds(srj)) {
        await writeFile(sourcePath, `${JSON.stringify(srj, null, 2)}\n`)
      }

      return {
        sampleName,
        sourceFile,
        connectionCount: srj.connections?.length ?? 0,
        obstacleCount: srj.obstacles?.length ?? 0,
        bgaLayer: srj.metadata?.bgaLayer,
        passiveLayer: srj.metadata?.passiveLayer,
        passiveOverlayCount: srj.metadata?.passiveOverlayCount ?? 0,
        bounds: srj.bounds,
      }
    }),
  )
}

await rm(datasetDistDir, { recursive: true, force: true })
await mkdir(datasetDistDir, { recursive: true })

const samples = await getSamples()

await writeFile(
  path.join(datasetDistDir, "manifest.json"),
  `${JSON.stringify(
    {
      datasetName: "dataset-srj19-bga-passive-overlays",
      sampleCount: samples.length,
      rule: "Every connection has exactly one endpoint on the centered BGA pad grid. IO fanout pads are placed on board edges. Passive component keepouts are placed as a deterministic random subset around the BGA footprint on the opposite PCB layer, with varied sizes, orientations, and offsets. Samples alternate BGA-top/passive-bottom and BGA-bottom/passive-top orientations.",
      samples,
    },
    null,
    2,
  )}\n`,
)
