declare module "graphics-debug/react" {
  import type { GraphicsObject } from "graphics-debug"
  import type { Matrix } from "transformation-matrix"

  export type GraphicsObjectClickEvent = {
    type:
      | "point"
      | "line"
      | "infinite-line"
      | "rect"
      | "circle"
      | "text"
      | "arrow"
      | "polygon"
    index: number
    object: unknown
  }

  export interface InteractiveGraphicsCanvasProps {
    graphics: GraphicsObject
    showLabelsByDefault?: boolean
    showGrid?: boolean
    height?: number | string
    width?: number | string
  }

  export interface InteractiveGraphicsProps {
    graphics: GraphicsObject
    onObjectClicked?: (event: GraphicsObjectClickEvent) => void
    objectLimit?: number
    height?: number
  }

  export interface CanvasGraphicsProps {
    graphics: GraphicsObject
    width?: number
    height?: number
    withGrid?: boolean
    initialTransform?: Matrix
    disableLabels?: boolean
  }

  export function InteractiveGraphics(
    props: InteractiveGraphicsProps,
  ): JSX.Element
  export function InteractiveGraphicsCanvas(
    props: InteractiveGraphicsCanvasProps,
  ): JSX.Element
  export function CanvasGraphics(props: CanvasGraphicsProps): JSX.Element
}
