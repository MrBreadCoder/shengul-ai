'use client'

import { useLayoutEffect, useRef } from 'react'
import { useInView, useReducedMotion } from 'motion/react'
import { annotate } from 'rough-notation'
import type { RoughAnnotation } from 'rough-notation/lib/model'

type AnnotationAction =
  | 'highlight'
  | 'underline'
  | 'box'
  | 'circle'
  | 'strike-through'
  | 'crossed-off'
  | 'bracket'

interface HighlighterProps {
  children: React.ReactNode
  /** Annotation style drawn around/behind the children. @default 'highlight' */
  action?: AnnotationAction
  /** Stroke/fill color. Pick something that fits the surrounding palette. */
  color?: string
  strokeWidth?: number
  /** Draw duration in ms. @default 600 */
  animationDuration?: number
  /** Number of sketch passes — >1 reads as hand-drawn. @default 2 */
  iterations?: number
  /** Space between the text and the annotation, in px. @default 2 */
  padding?: number
  /** Whether the annotation wraps across line breaks. @default true */
  multiline?: boolean
  /** Wait until the element scrolls into view before drawing. @default false */
  isView?: boolean
  /**
   * Milliseconds to wait after `shouldShow` becomes true before taking the
   * position snapshot rough-notation draws from. Needed when the children sit
   * inside a transform-based entrance animation (e.g. `Reveal`): drawing
   * immediately snapshots the pre-animation position and the stroke ends up
   * visually offset once the transform settles. @default 0
   */
  startDelay?: number
}

/**
 * Marker-style annotation drawn over its children with rough-notation, mimicking
 * a human highlighter/pen stroke. Redraws on resize so reflowed text (font swap,
 * viewport change) never leaves a stale stroke behind. Under
 * `prefers-reduced-motion` the annotation is shown instantly instead of
 * sketching in, matching how the rest of the landing page handles motion.
 */
export function Highlighter({
  children,
  action = 'highlight',
  color = '#ffd1dc',
  strokeWidth = 1.5,
  animationDuration = 600,
  iterations = 2,
  padding = 2,
  multiline = true,
  isView = false,
  startDelay = 0,
}: HighlighterProps): React.ReactElement {
  const elementRef = useRef<HTMLSpanElement>(null)
  const prefersReducedMotion = useReducedMotion()

  const isInView = useInView(elementRef, {
    once: true,
    margin: '-10%',
  })

  // If isView is false, always show. If isView is true, wait for inView.
  const shouldShow = !isView || isInView

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!shouldShow || !element) return undefined

    let annotation: RoughAnnotation | null = null
    let resizeObserver: ResizeObserver | null = null

    const draw = (): void => {
      const currentAnnotation = annotate(element, {
        type: action,
        color,
        strokeWidth,
        animationDuration: prefersReducedMotion ? 0 : animationDuration,
        iterations,
        padding,
        multiline,
      })

      annotation = currentAnnotation
      currentAnnotation.show()

      resizeObserver = new ResizeObserver(() => {
        currentAnnotation.hide()
        currentAnnotation.show()
      })

      resizeObserver.observe(element)
      resizeObserver.observe(document.body)
    }

    // No-op timeout (fires next tick) when startDelay is 0, so behavior is
    // unchanged for callers that don't need it.
    const timeoutId = window.setTimeout(draw, prefersReducedMotion ? 0 : startDelay)

    return () => {
      window.clearTimeout(timeoutId)
      annotation?.remove()
      resizeObserver?.disconnect()
    }
  }, [
    shouldShow,
    action,
    color,
    strokeWidth,
    animationDuration,
    iterations,
    padding,
    multiline,
    prefersReducedMotion,
    startDelay,
  ])

  // rough-notation inserts the annotation `<svg>` as a DOM *sibling* of the
  // ref'd element (`beforebegin`/`afterend`), not as its child — so setting
  // `position: relative` on the ref'd element itself does nothing for where
  // that svg anchors. Without a positioned ancestor nearby, the svg falls
  // back to the nearest ancestor with a CSS `transform` (e.g. a Framer
  // Motion wrapper like `Reveal`, which leaves an inline `transform` on its
  // element even at rest), which can be anywhere else on the page. Wrapping
  // in our own `position: relative` span makes that wrapper the sibling's
  // parent, so the svg always anchors here regardless of what any ancestor
  // outside our control is doing.
  //
  // `display: inline` (not `inline-block`) on both spans deliberately —
  // `inline-block` turns a multi-word phrase into one atomic box the browser
  // can't break for line-wrapping, so a highlighted phrase stops reflowing
  // with the rest of the sentence and can get stranded alone on its own
  // line. Plain `inline` still supports `position: relative`, and it's what
  // lets `multiline` do its job: rough-notation draws one stroke segment per
  // wrapped line via `getClientRects()`.
  return (
    <span className="relative">
      <span ref={elementRef}>{children}</span>
    </span>
  )
}
