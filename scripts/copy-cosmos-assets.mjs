import { cp, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outputRoot = path.join(repoRoot, "cosmos-export")
const outputDatasetDir = path.join(outputRoot, "dataset-dist")
const outputCircuitsDir = path.join(outputRoot, "circuits")

await mkdir(outputDatasetDir, { recursive: true })
await mkdir(outputCircuitsDir, { recursive: true })
await cp(
  path.join(repoRoot, "dataset-dist", "manifest.json"),
  path.join(outputDatasetDir, "manifest.json"),
)

const circuitEntries = await readdir(path.join(repoRoot, "circuits"), {
  withFileTypes: true,
})
for (const entry of circuitEntries) {
  if (!entry.isDirectory() || !/^sample\d{3}$/.test(entry.name)) continue

  const sourceFile = path.join(
    repoRoot,
    "circuits",
    entry.name,
    `${entry.name}.circuit.simple-route.json`,
  )
  const destinationDir = path.join(outputCircuitsDir, entry.name)
  await mkdir(destinationDir, { recursive: true })
  await cp(sourceFile, path.join(destinationDir, path.basename(sourceFile)))
}

console.log(
  `Copied ${circuitEntries.filter((entry) => entry.isDirectory() && /^sample\d{3}$/.test(entry.name)).length} sample assets into cosmos-export.`,
)

