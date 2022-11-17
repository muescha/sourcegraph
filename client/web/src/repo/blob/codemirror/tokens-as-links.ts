import * as H from 'history'
import { Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { History } from 'history'
import { Observable, Subject, Subscription } from 'rxjs'
import { concatMap, debounceTime, map } from 'rxjs/operators'
import { DeepNonNullable } from 'utility-types'

import { logger, toPositionOrRangeQueryParameter } from '@sourcegraph/common'
import { Occurrence, SyntaxKind } from '@sourcegraph/shared/src/codeintel/scip'
import { parseRepoURI, toPrettyBlobURL, toURIWithPath, UIRange } from '@sourcegraph/shared/src/util/url'

import { BlobInfo } from '../Blob'
import { DefinitionResponse, fetchDefinitionsFromRanges } from '../definitions'

import { SelectedLineRange, selectedLines } from './linenumbers'
import { Remote } from 'comlink'
import { FlatExtensionHostAPI } from '@sourcegraph/shared/src/api/contract'
import { proxySubscribable } from '@sourcegraph/shared/src/api/extension/api/common'
import { wrapRemoteObservable } from '@sourcegraph/shared/src/api/client/api/common'
import { TextDocumentPositionParameters } from '@sourcegraph/client-api'
import { getDefinitionURL } from '@sourcegraph/shared/src/hover/actions'
import { loadOptions } from '@babel/core'

interface TokenLink {
    range: UIRange
    url: string
}

/**
 * View plugin responsible for focusing a selected line when necessary.
 */
const focusSelectedLine = ViewPlugin.fromClass(
    class implements PluginValue {
        private lastSelectedLines: SelectedLineRange | null = null
        constructor(private readonly view: EditorView) {}

        public update(update: ViewUpdate): void {
            const currentSelectedLines = update.state.field(selectedLines)
            if (this.lastSelectedLines !== currentSelectedLines) {
                this.lastSelectedLines = currentSelectedLines
                this.focusLine(currentSelectedLines)
            }
        }

        public focusLine(selection: SelectedLineRange): void {
            if (selection) {
                const line = this.view.state.doc.line(selection.line)

                if (line) {
                    window.requestAnimationFrame(() => {
                        // Start from the line number of the current position, adding the additional count to get
                        // to a single character (if the character is present in the position)
                        const closestNode = this.view.domAtPos(line.from + (selection.character ?? 0)).node

                        const closestElement =
                            closestNode instanceof HTMLElement ? closestNode : closestNode.parentElement

                        // We will be trying to focus a data-token-link element in the event we were given a character position,
                        // otherwise we still want to default to focusing the entire line
                        const target =
                            closestElement?.hasAttribute('data-token-link') ||
                            closestElement?.hasAttribute('data-line-focusable')
                                ? closestElement
                                : closestElement?.closest<HTMLElement>('[data-token-link],[data-line-focusable]')

                        target?.focus()
                    })
                }
            }
        }
    }
)

class DefinitionManager implements PluginValue {
    private subscription: Subscription
    private visiblePositionRange: Subject<{ from: number; to: number }>

    constructor(private view: EditorView, private blobInfo: BlobInfo) {
        this.visiblePositionRange = new Subject()
        this.subscription = this.visiblePositionRange
            .pipe(
                debounceTime(200),
                concatMap(({ from, to }) => this.getDefinitionsLinksWithinRange(view, from, to))
            )
            .subscribe(definitionLinks => {
                requestAnimationFrame(() => {
                    this.view.dispatch({
                        effects: setTokenLinks.of(definitionLinks),
                    })
                })
            })

        // Trigger first update
        this.visiblePositionRange.next({ from: view.viewport.from, to: view.viewport.to })
    }

    public update(update: ViewUpdate): void {
        if (update.viewportChanged) {
            this.visiblePositionRange?.next({ from: update.view.viewport.from, to: update.view.viewport.to })
        }
    }

    public destroy(): void {
        this.subscription?.unsubscribe()
        requestAnimationFrame(() => {
            this.view.dispatch({
                effects: setTokenLinks.of([]),
            })
        })
    }

    /**
     * Fetch definitions for all stencil ranges within the viewport.
     */
    private getDefinitionsLinksWithinRange(
        view: EditorView,
        lineFrom: number,
        lineTo: number
    ): Observable<TokenLink[]> {
        const { repoName, filePath, revision, commitID } = this.blobInfo

        const from = view.state.doc.lineAt(lineFrom).number
        const to = view.state.doc.lineAt(lineTo).number

        // We only want to fetch definitions for ranges that:
        // 1. We know are valid (i.e. already set in the state)
        // 2. Are within the current viewport
        const ranges = view.state
            .field(tokenLinks)
            .filter(({ range }) => range.start.line + 1 >= from && range.end.line + 1 <= to)
            .map(({ range }) => range)

        /**
         * Fetch definitions from known ranges, and convert to `TokenLink`s
         */
        return fetchDefinitionsFromRanges({ ranges, repoName, filePath, revision }).pipe(
            map(results => {
                if (results === null) {
                    return []
                }

                return results
                    .filter((result): result is DeepNonNullable<DefinitionResponse> => Boolean(result.definition))
                    .map(({ range, definition }) => {
                        // Preserve the users current revision (e.g., a Git branch name instead of a Git commit SHA)
                        // This avoids navigating the user from (e.g.) a URL with a nice Git
                        // branch name to a URL with a full Git commit SHA.
                        const targetRevision =
                            definition.resource.repository.name === repoName &&
                            definition.resource.commit.oid === commitID
                                ? revision
                                : definition.resource.commit.oid

                        return {
                            range,
                            url: toPrettyBlobURL({
                                repoName: definition.resource.repository.name,
                                filePath: definition.resource.path,
                                revision: targetRevision,
                                position: definition.range
                                    ? {
                                          line: definition.range.start.line + 1,
                                          character: definition.range.start.character,
                                      }
                                    : undefined,
                            }),
                        }
                    })
            })
        )
    }
}

/**
 * Given a set of TokenLinks, returns a decoration set that wraps each specified range in a `<a>` tag.
 */
function tokenLinksToRangeSet(view: EditorView, links: TokenLink[]): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()

    try {
        for (const { range } of links) {
            const from = view.state.doc.line(range.start.line + 1).from + range.start.character
            const to = view.state.doc.line(range.end.line + 1).from + range.end.character
            const decoration = Decoration.mark({
                attributes: {
                    class: 'sourcegraph-token-link',
                    'data-token-link': '',
                },
                tagName: 'span',
            })
            builder.add(from, to, decoration)
        }
    } catch (error) {
        logger.error('Failed to compute decorations', error)
    }

    return builder.finish()
}

const setTokenLinks = StateEffect.define<TokenLink[]>()
const tokenLinks = StateField.define<TokenLink[]>({
    create() {
        return []
    },
    update(currentLinks, transaction) {
        for (const effect of transaction.effects) {
            if (effect.is(setTokenLinks)) {
                const mergedLinks: TokenLink[] = []

                for (const base of currentLinks) {
                    const updated = effect.value.find(
                        link =>
                            link.range.start.line === base.range.start.line &&
                            link.range.start.character === base.range.start.character &&
                            link.range.end.line === base.range.end.line &&
                            link.range.end.character === base.range.end.character
                    )

                    if (updated) {
                        mergedLinks.push(updated)
                    } else {
                        mergedLinks.push(base)
                    }
                }

                return mergedLinks
            }
        }

        return currentLinks
    },
    provide(field) {
        return EditorView.decorations.from(field, links => {
            let decorations: DecorationSet | null = null

            return view => {
                if (decorations) {
                    return decorations
                }

                return (decorations = tokenLinksToRangeSet(view, links))
            }
        })
    },
})

interface TokensAsLinksConfiguration {
    codeintel?: Remote<FlatExtensionHostAPI>
    history: History
    blobInfo: BlobInfo
    preloadGoToDefinition: boolean
}

/**
 * Occurrences that are possibly interactive (i.e. they can have code intelligence).
 */
const INTERACTIVE_OCCURRENCE_KINDS = new Set([
    SyntaxKind.Identifier,
    SyntaxKind.IdentifierBuiltin,
    SyntaxKind.IdentifierConstant,
    SyntaxKind.IdentifierMutableGlobal,
    SyntaxKind.IdentifierParameter,
    SyntaxKind.IdentifierLocal,
    SyntaxKind.IdentifierShadowed,
    SyntaxKind.IdentifierModule,
    SyntaxKind.IdentifierFunction,
    SyntaxKind.IdentifierFunctionDefinition,
    SyntaxKind.IdentifierMacro,
    SyntaxKind.IdentifierMacroDefinition,
    SyntaxKind.IdentifierType,
    SyntaxKind.IdentifierBuiltinType,
    SyntaxKind.IdentifierAttribute,
])

const isInteractiveOccurrence = (occurence: Occurrence): boolean => {
    if (!occurence.kind) {
        return false
    }

    return INTERACTIVE_OCCURRENCE_KINDS.has(occurence.kind)
}

export const tokensAsLinks = ({
    codeintel,
    history,
    blobInfo,
    preloadGoToDefinition,
}: TokensAsLinksConfiguration): Extension => {
    const ranges = Occurrence.fromInfo(blobInfo)
        .filter(isInteractiveOccurrence)
        .map(({ range }) => range)

    const referencesLinks =
        ranges.map(range => ({
            range,
            url: `?${toPositionOrRangeQueryParameter({
                position: { line: range.start.line + 1, character: range.start.character + 1 },
            })}#tab=references`,
        })) ?? []

    return [
        focusSelectedLine,
        tokenLinks.init(() => referencesLinks),
        preloadGoToDefinition ? ViewPlugin.define(view => new DefinitionManager(view, blobInfo)) : [],
        EditorView.domEventHandlers({
            contextmenu(event, editor) {
                if (event.shiftKey) {
                    return
                }
                const coords: IScreenCoord = {
                    x: event.clientX,
                    y: event.clientY,
                }
                const position = editor.posAtCoords(coords)
                if (position === null) {
                    return
                }
                if (!codeintel) {
                    return
                }
                event.preventDefault()
                const cmLine = editor.state.doc.lineAt(position)
                const line = cmLine.number - 1
                const uri = toURIWithPath(blobInfo)
                const character = position - cmLine.from
                const menu = document.createElement('div')
                const definition = document.createElement('div')
                definition.innerHTML = 'Go to definition'
                definition.classList.add('codeintel-contextmenu-item')
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                definition.addEventListener('click', () => {
                    goToDefinition(history, codeintel, {
                        position: { line, character },
                        textDocument: { uri },
                    }).then(
                        () => {},
                        () => {}
                    )
                })
                menu.append(definition)

                const references = document.createElement('div')
                references.innerHTML = 'Find references'
                references.classList.add('codeintel-contextmenu-item')
                menu.append(references)

                const browserMenu = document.createElement('div')
                browserMenu.innerHTML = 'Browser context menu shift+right-click'
                browserMenu.classList.add('codeintel-contextmenu-item')
                menu.append(browserMenu)
                console.log(menu)
                showTooltip(editor, menu, coords)

                console.log(event)
            },
            click(event: MouseEvent) {
                const target = event.target as HTMLElement
                console.log({ target, cmd: event.metaKey })

                // Check to see if the clicked target is a token link.
                // If it is, push the link to the history stack.
                if (target.matches('[data-token-link]')) {
                    event.preventDefault()
                    history.push(target.getAttribute('href')!)
                }
            },
        }),
    ]
}

async function goToDefinition(
    history: H.History,
    codeintel: Remote<FlatExtensionHostAPI>,
    params: TextDocumentPositionParameters
): Promise<void> {
    const definition = await codeintel.getDefinition(params)
    // eslint-disable-next-line ban/ban
    await wrapRemoteObservable(definition).forEach(result => {
        if (result.isLoading) {
            return
        }
        if (result.result.length === 1) {
            const location = result.result[0]
            const uri = parseRepoURI(location.uri)
            if (uri.filePath && location.range) {
                const href = toPrettyBlobURL({
                    repoName: uri.repoName,
                    revision: uri.revision,
                    filePath: uri.filePath,
                    position: { line: location.range.start.line + 1, character: location.range.start.character + 1 },
                })
                console.log({ href })
                history.push(href)
            }
        }
    })
}

interface IScreenCoord {
    x: number
    y: number
}

function showTooltip(editor: EditorView, element: HTMLElement, coords: IScreenCoord): void {
    let top = coords.y // - editor.contentHeight

    const tooltip = document.createElement('div')
    tooltip.classList.add('codeintel-tooltip')
    tooltip.style.left = `${coords.x}px`
    tooltip.style.top = `${top}px`
    tooltip.append(element)
    document.body.append(tooltip)
    let counter = 0
    const tooltipCloseListener = (): void => {
        counter += 1
        if (counter === 1) {
            return
        }
        tooltip.remove()
        document.removeEventListener('click', tooltipCloseListener)
        document.removeEventListener('contextmenu', tooltipCloseListener)
    }
    document.addEventListener('contextmenu', tooltipCloseListener)
    document.addEventListener('click', tooltipCloseListener)
    // TODO: register up/down arrows

    // Measure and reposition after rendering first version
    requestAnimationFrame(() => {
        // top += editor.contentHeight
        top -= tooltip.offsetHeight

        tooltip.style.left = `${coords.x}px`
        tooltip.style.top = `${top}px`
    })
}
