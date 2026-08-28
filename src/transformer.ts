import type { QuartzTransformerPlugin, BuildCtx } from "@quartz-community/types"
import type { FullSlug, RelativeURL, SimpleSlug, TransformOptions } from "@quartz-community/utils"
import {
  stripSlashes,
  simplifySlug,
  splitAnchor,
  transformInternalLink,
  isFolderPath,
  resolveRelative,
  joinSegments,
  pathToRoot,
} from "@quartz-community/utils"
import path from "path"
import { visit } from "unist-util-visit"
import isAbsoluteUrl from "is-absolute-url"
import type { Root, Element, Text } from "hast"
import type { VFile } from "vfile"

export interface CrawlLinksOptions {
  /** How to resolve Markdown paths */
  markdownLinkResolution: TransformOptions["strategy"]
  /** Strips folders from a link so that it looks nice */
  prettyLinks: boolean
  openLinksInNewTab: boolean
  lazyLoad: boolean
  externalLinkIcon: boolean
  /**
   * When `true`, internal links whose resolved slug is not present in
   * `ctx.allSlugs` gain a `broken` CSS class (alongside `internal`) so
   * broken links can be styled distinctly. Applies to both wikilinks
   * (after they've been converted to `<a>` elements by
   * ObsidianFlavoredMarkdown) and markdown links, since both are
   * indistinguishable `<a>` nodes at this phase of the pipeline.
   */
  disableBrokenWikilinks: boolean
}

const defaultOptions: CrawlLinksOptions = {
  markdownLinkResolution: "absolute",
  prettyLinks: true,
  openLinksInNewTab: false,
  lazyLoad: false,
  externalLinkIcon: true,
  disableBrokenWikilinks: false,
}

const isAbsoluteUrlWithOptions = isAbsoluteUrl as (
  url: string,
  options?: { httpOnly?: boolean },
) => boolean

// CONFIRMED BUG (2026-08-28) in the real @quartz-community/utils transformLink(), fork of
// this plugin: @quartz-community/utils is installed via an unpinned git ref, so different
// consumers' separate npm installs can resolve different actual commits under the identical
// declared "0.1.0" version. transformInternalLink() in THIS plugin's resolved copy lowercases
// its input (confirmed: transformInternalLink("Sune") -> "./sune"), while real content slugs
// (ctx.allSlugs, computed by core Quartz from a DIFFERENT resolved copy) preserve case
// ("Sune", not "sune"). The upstream "shortest" strategy does an exact-match filter
// (`targetCanonical === fileName`) between these two values - which can never succeed once one
// side is silently lowercased and the other isn't, so EVERY wikilink with any uppercase letter
// (i.e. essentially every wikilink in a normally-titled vault) falls through to the naive
// site-root-relative fallback instead of the real resolved path. This is the actual upstream
// transformLink() reimplemented here verbatim, with ONE change: the shortest-strategy match is
// case-insensitive, which is robust regardless of which side (or neither, or both) is lowercased
// by whatever commit each separate npm install happens to resolve.
function fixedTransformLink(
  src: FullSlug,
  target: RelativeURL,
  opts: TransformOptions,
): RelativeURL {
  const targetSlug = transformInternalLink(target)
  if (opts.strategy === "relative") {
    return targetSlug
  } else {
    const folderTail = isFolderPath(targetSlug) ? "/" : ""
    const canonicalSlug = stripSlashes(targetSlug.slice(".".length))
    const [targetCanonical, targetAnchor] = splitAnchor(canonicalSlug)
    if (opts.strategy === "shortest") {
      const targetCanonicalLower = targetCanonical.toLowerCase()
      const matchingFileNames = opts.allSlugs.filter((slug) => {
        const parts = slug.split("/")
        const fileName = parts.at(-1)
        return targetCanonicalLower === (fileName ?? "").toLowerCase()
      })
      if (matchingFileNames.length === 1) {
        const matchedSlug = matchingFileNames[0] as FullSlug
        return (resolveRelative(src, matchedSlug) + targetAnchor) as RelativeURL
      }
    }
    return (joinSegments(pathToRoot(src), canonicalSlug) + folderTail) as RelativeURL
  }
}

export const CrawlLinks: QuartzTransformerPlugin<Partial<CrawlLinksOptions>> = (
  userOpts?: Partial<CrawlLinksOptions>,
) => {
  const opts = { ...defaultOptions, ...userOpts }
  return {
    name: "LinkProcessing",
    htmlPlugins(ctx: BuildCtx) {
      return [
        () => {
          return (tree: Root, file: VFile) => {
            const fileSlug = file.data.slug as FullSlug
            const curSlug = simplifySlug(fileSlug)
            const outgoing: Set<SimpleSlug> = new Set()

            const transformOptions: TransformOptions = {
              strategy: opts.markdownLinkResolution,
              allSlugs: ctx.allSlugs,
            }

            visit(tree, "element", (node: Element) => {
              // rewrite all links
              if (
                node.tagName === "a" &&
                node.properties &&
                typeof node.properties.href === "string"
              ) {
                let dest = node.properties.href as RelativeURL
                const classes = (node.properties.className ?? []) as string[]
                const isExternal = isAbsoluteUrlWithOptions(dest, { httpOnly: false })
                if (isExternal) {
                  classes.push("external", "external-link")
                } else {
                  classes.push("internal", "internal-link")
                }

                if (isExternal && opts.externalLinkIcon) {
                  node.children.push({
                    type: "element",
                    tagName: "svg",
                    properties: {
                      "aria-hidden": "true",
                      class: "external-icon",
                      style: "max-width:0.8em;max-height:0.8em",
                      viewBox: "0 0 512 512",
                    },
                    children: [
                      {
                        type: "element",
                        tagName: "path",
                        properties: {
                          d: "M320 0H288V64h32 82.7L201.4 265.4 178.7 288 224 333.3l22.6-22.6L448 109.3V192v32h64V192 32 0H480 320zM32 32H0V64 480v32H32 456h32V480 352 320H424v32 96H64V96h96 32V32H160 32z",
                        },
                        children: [],
                      },
                    ],
                  })
                }

                // Check if the link has alias text
                const firstChild = node.children[0]
                if (
                  node.children.length === 1 &&
                  firstChild?.type === "text" &&
                  firstChild.value !== dest
                ) {
                  // Add the 'alias' class if the text content is not the same as the href
                  classes.push("alias")
                }
                node.properties.className = classes

                if (isExternal && opts.openLinksInNewTab) {
                  node.properties.target = "_blank"
                }

                const isInternal = !(
                  isAbsoluteUrlWithOptions(dest, { httpOnly: false }) || dest.startsWith("#")
                )
                if (isInternal) {
                  dest = node.properties.href = fixedTransformLink(fileSlug, dest, transformOptions)

                  // url.resolve is considered legacy
                  // WHATWG equivalent https://nodejs.dev/en/api/v18/url/#urlresolvefrom-to
                  const url = new URL(dest, "https://base.com/" + stripSlashes(curSlug, true))
                  const canonicalDest = url.pathname
                  const [destCanonicalRaw, _destAnchor] = splitAnchor(canonicalDest)
                  let destCanonical = destCanonicalRaw
                  if (destCanonical.endsWith("/")) {
                    destCanonical += "index"
                  }

                  // need to decodeURIComponent here as WHATWG URL percent-encodes everything
                  const full = decodeURIComponent(stripSlashes(destCanonical, true)) as FullSlug
                  const simple = simplifySlug(full)
                  outgoing.add(simple)
                  node.properties["data-slug"] = full

                  if (opts.disableBrokenWikilinks && !ctx.allSlugs.includes(full)) {
                    classes.push("broken")
                    node.properties.className = classes
                  }
                }

                // rewrite link internals if prettylinks is on
                if (opts.prettyLinks && isInternal && node.children.length === 1) {
                  const hasAlias = classes.includes("alias")
                  const textChild = node.children[0] as Text | undefined
                  if (textChild?.type === "text" && !textChild.value.startsWith("#") && !hasAlias) {
                    textChild.value = path.basename(textChild.value)
                  }
                }
              }

              // transform all other resources that may use links
              if (
                ["img", "video", "audio", "iframe"].includes(node.tagName) &&
                node.properties &&
                typeof node.properties.src === "string"
              ) {
                if (opts.lazyLoad) {
                  node.properties.loading = "lazy"
                }

                if (!isAbsoluteUrlWithOptions(node.properties.src, { httpOnly: false })) {
                  let dest = node.properties.src as RelativeURL
                  dest = node.properties.src = fixedTransformLink(fileSlug, dest, transformOptions)
                  node.properties.src = dest
                }
              }
            })

            const frontmatterLinks = (file.data.frontmatterLinks as string[] | undefined) ?? []
            for (const fmLink of frontmatterLinks) {
              const [targetRaw] = splitAnchor(fmLink)
              if (!targetRaw) continue
              const dest = fixedTransformLink(fileSlug, targetRaw as RelativeURL, transformOptions)
              const url = new URL(dest, "https://base.com/" + stripSlashes(curSlug, true))
              const [canonicalRaw] = splitAnchor(url.pathname)
              let canonical = canonicalRaw
              if (canonical.endsWith("/")) canonical += "index"
              const full = decodeURIComponent(stripSlashes(canonical, true)) as FullSlug
              outgoing.add(simplifySlug(full))
            }

            file.data.links = [...outgoing]
          }
        },
      ]
    },
  }
}
