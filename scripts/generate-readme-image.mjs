import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AutoroutingPipelineSolver } from "@tscircuit/capacity-autorouter";
import { getSvgFromGraphicsObject } from "graphics-debug";

const sampleUrl = new URL(
	"../circuits/sample001/sample001.circuit.simple-route.json",
	import.meta.url,
);
const outputUrl = new URL("../docs/sample.svg", import.meta.url);
const sample = await Bun.file(sampleUrl).json();
const solver = new AutoroutingPipelineSolver(structuredClone(sample));
const svg = getSvgFromGraphicsObject(solver.visualize(), {
	backgroundColor: "#ffffff",
	svgWidth: 1200,
	svgHeight: 800,
}).replace(/[ \\t]+$/gm, "");

await mkdir(dirname(outputUrl.pathname), { recursive: true });
await Bun.write(outputUrl, svg);
console.log(`Wrote ${outputUrl.pathname}`);
