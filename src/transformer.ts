import type { QuartzTransformerPlugin, BuildCtx } from "@quartz-community/types"
import type { FullSlug, RelativeURL, SimpleSlug, TransformOptions } from "@quartz-community/utils"
import {
  stripSlashes,
  simplifySlug,
  splitAnchor,
  isFolderPath,
  resolveRelative,
  joinSegments,
  pathToRoot,
  getFileExtension,
  endsWith,
} from "@quartz-community/utils"
import path from "path"
import { visit } from "unist-util-visit"
import isAbsoluteUrl from "is-absolute-url"
import type { Root, Element, Text } from "hast"
import type { VFile } from "vfile"

// Case-safe reimplementation of slugifyPath()/slugifyFilePath()/transformInternalLink()
// from @quartz-community/utils, identical to the real logic EXCEPT slugifyPath's
// unconditional `.toLowerCase()` is omitted — that call is the actual root cause of the
// version-drift bug (see the long comment on fixedTransformLink below). ctx.allSlugs (used
// by the "shortest" strategy below) only ever contains REAL file slugs — confirmed in core
// quartz/build.ts, where it's computed as `allFiles.map(slugifyFilePath)` before any
// emitter runs — so it never includes virtual folder/tag index pages (e.g.
// "Characters/NPCs/index"). That means matching against allSlugs can never recover the
// correct case for a folder-style target like [[Characters/NPCs/]]; the only reliable fix
// is to never let the drifted lowercasing happen in the first place. All the other pieces
// used below (stripSlashes, getFileExtension, endsWith, isFolderPath, joinSegments,
// splitAnchor, simplifySlug) are pure structural string operations with no case-sensitivity
// of their own — safe to use regardless of which drifted commit this install resolved.
function caseSafeSlugifyPath(s: string): string {
  return s
    .split("/")
    .map((segment) =>
      segment
        .replace(/\s/g, "-")
        .replace(/&/g, "-and-")
        .replace(/%/g, "-percent")
        .replace(/\?/g, "")
        .replace(/#/g, "")
        .replace(/[<>:"|*]/g, ""),
    )
    .join("/")
    .replace(/\/$/, "")
}

function caseSafeSlugifyFilePath(fp: string): string {
  fp = stripSlashes(fp as RelativeURL)
  const ext = getFileExtension(fp)
  const withoutFileExt = ext ? fp.slice(0, -ext.length) : fp
  const finalExt = [".md", ".html", undefined].includes(ext) ? "" : ext
  let slug = caseSafeSlugifyPath(withoutFileExt)
  if (endsWith(slug as RelativeURL, "_index")) {
    slug = slug.replace(/_index$/, "index")
  }
  const segments = slug.split("/")
  if (segments.length >= 2 && segments[segments.length - 1] === segments[segments.length - 2]) {
    segments[segments.length - 1] = "index"
    slug = segments.join("/")
  }
  return slug + (finalExt ?? "")
}

function isRelativeSegment(s: string): boolean {
  return /^\.{0,2}$/.test(s)
}

function addRelativeToStart(s: string): string {
  if (s === "") return "."
  if (!s.startsWith(".")) return joinSegments(".", s)
  return s
}

function caseSafeTransformInternalLink(link: string): RelativeURL {
  const [fplike, anchorRaw] = splitAnchor(decodeURI(link))
  const anchor = anchorRaw ?? ""
  const segments = fplike.split("/").filter((x) => x.length > 0)
  const prefix = segments.filter(isRelativeSegment).join("/")
  const fp = segments.filter((seg) => !isRelativeSegment(seg) && seg !== "").join("/")
  const slugged = caseSafeSlugifyFilePath(fp)
  const simpleSlug = simplifySlug(slugged as FullSlug)
  const folderPath = isFolderPath(fplike as RelativeURL) || isFolderPath(slugged as RelativeURL)
  const joined = joinSegments(
    stripSlashes(prefix as RelativeURL),
    stripSlashes(simpleSlug as unknown as RelativeURL),
  )
  const trail = folderPath ? "/" : ""
  return (addRelativeToStart(joined) + trail + anchor) as RelativeURL
}

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

// CONFIRMED BUG (2026-08-28, final fix) in the real @quartz-community/utils transformLink(),
// fork of this plugin: @quartz-community/utils is installed via an unpinned git ref, so
// different consumers' separate npm installs can resolve different actual commits under the
// identical declared "0.1.0" version. The real transformInternalLink() in THIS plugin's
// resolved copy lowercases its input via slugifyFilePath()->_sluggify()->slugifyPath()'s
// unconditional `.toLowerCase()` (confirmed: transformInternalLink("Sune") -> "./sune"), while
// real content slugs (ctx.allSlugs, computed by core Quartz from a DIFFERENT resolved copy)
// preserve case ("Sune", not "sune").
//
// Two earlier attempts at this fix (both 2026-08-28) tried to recover the correct case AFTER
// the fact, by matching the lowercased result against `opts.allSlugs`. Both were incomplete:
// attempt 1 only handled bare-filename "shortest" targets; attempt 2 added multi-segment/
// folder-index matching, but still failed for every folder-path target (e.g.
// `[[Characters/NPCs/]]`, confirmed broken live on the site's own homepage) — because
// `ctx.allSlugs` (confirmed in core quartz/build.ts: `allFiles.map(slugifyFilePath)`, computed
// before any emitter runs) never contains virtual folder/tag index page slugs, so there is
// nothing in it to match a folder target against.
//
// The only reliable fix is to never let the drifted lowercasing happen at all: this file locally
// reimplements slugifyPath()/slugifyFilePath()/transformInternalLink() (as
// caseSafeSlugifyPath/caseSafeSlugifyFilePath/caseSafeTransformInternalLink above), identical to
// the real logic except omitting slugifyPath's `.toLowerCase()` call — the actual root cause.
// Every other piece those helpers use (stripSlashes, getFileExtension, endsWith, isFolderPath,
// joinSegments, splitAnchor, simplifySlug) is a pure structural string operation with no
// case-sensitivity of its own, so importing them from whichever drifted copy resolves is safe.
function fixedTransformLink(
  src: FullSlug,
  target: RelativeURL,
  opts: TransformOptions,
): RelativeURL {
  const targetSlug = caseSafeTransformInternalLink(target)
  if (opts.strategy === "relative") {
    return targetSlug
  } else {
    const effectiveSrc =
      !src.endsWith("index") && opts.allSlugs.includes(`${src}/index` as FullSlug)
        ? (`${src}/index` as FullSlug)
        : src
    const folderTail = isFolderPath(targetSlug) ? "/" : ""
    const canonicalSlug = stripSlashes(targetSlug.slice(".".length))
    const [targetCanonical, targetAnchor] = splitAnchor(canonicalSlug)
    if (opts.strategy === "shortest") {
      const targetCanonicalLower = targetCanonical.toLowerCase()
      const isMultiSegment = targetCanonical.includes("/")
      const isFolderTarget = isFolderPath(targetSlug)
      const matchingFileNames = opts.allSlugs.filter((slug) => {
        const slugLower = slug.toLowerCase()
        if (isMultiSegment) {
          if (
            slugLower === targetCanonicalLower ||
            slugLower.endsWith("/" + targetCanonicalLower)
          ) {
            return true
          }
          if (isFolderTarget) {
            const withIndexLower = targetCanonicalLower + "/index"
            return slugLower === withIndexLower || slugLower.endsWith("/" + withIndexLower)
          }
          return false
        }
        const parts = slug.split("/")
        const fileName = (parts.at(-1) ?? "").toLowerCase()
        return targetCanonicalLower === fileName
      })
      if (matchingFileNames.length === 1) {
        const matchedSlug = matchingFileNames[0] as FullSlug
        return (resolveRelative(effectiveSrc, matchedSlug) + targetAnchor) as RelativeURL
      }
    }
    return (joinSegments(pathToRoot(effectiveSrc), canonicalSlug) + folderTail) as RelativeURL
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

                const rawSrc = node.properties.src
                if (
                  !isAbsoluteUrlWithOptions(rawSrc, { httpOnly: false }) &&
                  !rawSrc.startsWith("//")
                ) {
                  // Split the RAW fragment off before resolution — fixedTransformLink's
                  // internal splitAnchor() re-slugifies (and lowercases) any anchor it sees,
                  // which is correct for a heading-link anchor on an href but wrong for a
                  // case-sensitive SVG fragment id (`![[diagram.svg#LayerA]]`). Resolve only
                  // the anchor-free path, then reattach the original anchor untouched.
                  const hashIdx = rawSrc.indexOf("#")
                  const rawPath = (
                    hashIdx === -1 ? rawSrc : rawSrc.slice(0, hashIdx)
                  ) as RelativeURL
                  const rawFragment = hashIdx === -1 ? "" : rawSrc.slice(hashIdx)
                  const resolvedPath = fixedTransformLink(fileSlug, rawPath, transformOptions)
                  // Unlike page links (which must preserve case — see fixedTransformLink's
                  // header comment), binary assets are unconditionally lowercased on copy by
                  // core's assets.ts emitter, so this branch's case-preserving resolution can
                  // mismatch the lowercased file actually on disk. `iframe` is excluded: its
                  // src can legitimately be an internal content page (case-preserving slug),
                  // not a copied asset, and there's no reliable way to tell those apart from
                  // the resolved path alone (a page slug can itself contain a literal `.`,
                  // e.g. a note titled "Guide.V2", defeating any extension-based check) — img/
                  // video/audio embeds are always binary media in this codebase's actual
                  // usage, never a page, so lowercasing only those is safe.
                  // KNOWN LIMITATION: a hand-authored raw HTML `<iframe src="Case.PDF">`
                  // embedding a local binary asset (not produced by OFM's own wikilink-embed
                  // syntax, which renders PDF embeds as a transclusion blockquote, not an
                  // iframe) would still 404 here, since iframe is unconditionally exempted.
                  // Accepted: no such usage exists in this site's content today, and closing
                  // it needs a real asset-vs-page manifest, not another string heuristic.
                  const shouldLowercase = node.tagName !== "iframe"
                  node.properties.src = ((
                    shouldLowercase ? resolvedPath.toLowerCase() : resolvedPath
                  ) + rawFragment) as RelativeURL
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
