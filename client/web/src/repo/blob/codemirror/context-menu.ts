import { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { Remote } from 'comlink'
import * as H from 'history'

import { TextDocumentPositionParameters } from '@sourcegraph/client-api'
import { wrapRemoteObservable } from '@sourcegraph/shared/src/api/client/api/common'
import { FlatExtensionHostAPI } from '@sourcegraph/shared/src/api/contract'
import { Occurrence, Position, Range } from '@sourcegraph/shared/src/codeintel/scip'
import { parseRepoURI, toPrettyBlobURL, toURIWithPath } from '@sourcegraph/shared/src/util/url'

import { BlobInfo } from '../Blob'

import { syntaxHighlight } from './highlight'
import { isInteractiveOccurrence } from './tokens-as-links'

import styles from './context-menu.module.scss'
import { COMPLETIONSTATEMENT_TYPES } from '@babel/types'

function occurrenceAtEvent(
    view: EditorView,
    event: MouseEvent,
    blobInfo: BlobInfo
): { occurrence: Occurrence; position: Position; coords: Coordinates } | undefined {
    const atEvent = positionAtEvent(view, event, blobInfo)
    if (!atEvent) {
        return
    }
    const { position, coords } = atEvent
    const table = view.state.facet(syntaxHighlight)
    for (
        let index = table.lineIndex[position.line];
        index !== undefined &&
        index < table.occurrences.length &&
        table.occurrences[index].range.start.line === position.line;
        index++
    ) {
        const occurrence = table.occurrences[index]
        if (occurrence.range.contains(position)) {
            return { occurrence, position, coords }
        }
    }
    return
}

function goToDefinitionAtEvent(
    view: EditorView,
    event: MouseEvent,
    blobInfo: BlobInfo,
    history: H.History,
    codeintel: Remote<FlatExtensionHostAPI>
): Promise<() => void> {
    const atEvent = occurrenceAtEvent(view, event, blobInfo)
    if (!atEvent) {
        return Promise.resolve(() => {})
    }
    const { occurrence, position, coords } = atEvent
    if (!isInteractiveOccurrence(occurrence)) {
        return Promise.resolve(() => {})
    }
    const fromCache = definitionCache.get(occurrence)
    if (fromCache) {
        return fromCache
    }
    const uri = toURIWithPath(blobInfo)
    const promise = goToDefinition(view, history, codeintel, { position, textDocument: { uri } }, coords)
    definitionCache.set(occurrence, promise)
    return promise
}
function positionAtEvent(
    view: EditorView,
    event: MouseEvent,
    blobInfo: BlobInfo
): { position: Position; coords: Coordinates } | undefined {
    const coords: Coordinates = {
        x: event.clientX,
        y: event.clientY,
    }
    const position = view.posAtCoords(coords)
    if (position === null) {
        return
    }
    event.preventDefault()
    const cmLine = view.state.doc.lineAt(position)
    const line = cmLine.number - 1
    const character = position - cmLine.from
    return { position: new Position(line, character), coords }
}

const definitionCache = new Map<Occurrence, Promise<() => void>>()

// HACK: we store the editor view in a global variable so that we can access it
// from global keydown/keyup event handlers even when the editor is not focused.
// The `keydown` handler in EditorView.domEventHandler doesn't capture events
// when the editor is out of focus.
let globalViewHack: EditorView | undefined
const globalEventHandler = (event: KeyboardEvent): void => {
    if (!globalViewHack) {
        return
    }
    if (event.metaKey) {
        globalViewHack.contentDOM.classList.add(styles.clickable)
    } else {
        globalViewHack.contentDOM.classList.remove(styles.clickable)
    }
}

export function contextMenu(
    codeintel: Remote<FlatExtensionHostAPI> | undefined,
    blobInfo: BlobInfo,
    history: H.History
): Extension {
    document.removeEventListener('keydown', globalEventHandler)
    document.addEventListener('keydown', globalEventHandler)
    document.removeEventListener('keyup', globalEventHandler)
    document.addEventListener('keyup', globalEventHandler)

    return [
        EditorView.domEventHandlers({
            mouseover(event, view) {
                globalViewHack = view

                if (!codeintel) {
                    return
                }
                // toggleClickableClass(view, event.metaKey)
                goToDefinitionAtEvent(view, event, blobInfo, history, codeintel).then(
                    () => {},
                    () => {}
                )
            },
            click(event, view) {
                if (!codeintel) {
                    return
                }
                if (!event.metaKey) {
                    return
                }
                const spinner = new Spinner({
                    x: event.clientX,
                    y: event.clientY,
                })
                goToDefinitionAtEvent(view, event, blobInfo, history, codeintel)
                    .then(
                        action => action(),
                        () => {}
                    )
                    .finally(() => spinner.stop())
            },
            contextmenu(event, view) {
                if (event.shiftKey) {
                    return
                }
                if (!codeintel) {
                    return
                }
                const atEvent = positionAtEvent(view, event, blobInfo)
                if (!atEvent) {
                    return
                }
                const definitionAction = goToDefinitionAtEvent(view, event, blobInfo, history, codeintel)
                const { coords } = atEvent
                const menu = document.createElement('div')
                const definition = document.createElement('div')
                definition.innerHTML = 'Go to definition'
                definition.classList.add('codeintel-contextmenu-item')
                definition.classList.add('codeintel-contextmenu-item-action')

                definition.addEventListener('click', () => {
                    const spinner = new Spinner(coords)
                    definitionAction
                        .then(
                            action => action(),
                            () => {}
                        )
                        .finally(() => spinner.stop())
                })
                menu.append(definition)

                const references = document.createElement('div')
                references.innerHTML = 'Find references'
                references.classList.add('codeintel-contextmenu-item')
                references.classList.add('codeintel-contextmenu-item-action')
                menu.append(references)

                const browserMenu = document.createElement('div')
                browserMenu.innerHTML = 'Browser context menu shift+right-click'
                browserMenu.classList.add('codeintel-contextmenu-item')
                menu.append(browserMenu)
                showTooltip(view, menu, coords)
            },
        }),
    ]
}

interface Coordinates {
    x: number
    y: number
}

function showTooltip(view: EditorView, element: HTMLElement, coords: Coordinates, clearTimeout?: number): void {
    const tooltip = document.createElement('div')
    tooltip.classList.add('codeintel-tooltip')
    tooltip.style.left = `${coords.x}px`
    tooltip.style.top = `${coords.y}px`
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
    if (clearTimeout) {
        setTimeout(() => {
            tooltipCloseListener()
            tooltipCloseListener()
        }, clearTimeout)
    }
    // TODO: register up/down arrows

    // Measure and reposition after rendering first version
    requestAnimationFrame(() => {
        tooltip.style.left = `${coords.x}px`
        tooltip.style.top = `${top}px`
    })
}

async function goToDefinition(
    view: EditorView,
    history: H.History,

    codeintel: Remote<FlatExtensionHostAPI>,
    params: TextDocumentPositionParameters,
    coords: Coordinates
): Promise<() => void> {
    const definition = await codeintel.getDefinition(params)

    const result = await wrapRemoteObservable(definition).toPromise()
    if (result.isLoading) {
        return () => {}
    }
    if (result.result.length === 0) {
        return () => {
            const element = document.createElement('div')
            element.textContent = 'No definition found'
            element.style.color = 'white'
            element.style.backgroundColor = 'deepskyblue'
            showTooltip(view, element, coords, 2000)
        }
    }
    for (const location of result.result) {
        if (location.uri === params.textDocument.uri && location.range && location.range) {
            const requestPosition = new Position(params.position.line, params.position.character)
            const {
                start: { line: startLine, character: startCharacter },
                end: { line: endLine, character: endCharacter },
            } = location.range
            const resultRange = Range.fromNumbers(startLine, startCharacter, endLine, endCharacter)
            if (resultRange.contains(requestPosition)) {
                return () => {
                    const element = document.createElement('div')
                    element.textContent = 'You are at the definition'
                    element.style.color = 'white'
                    element.style.backgroundColor = 'deepskyblue'
                    showTooltip(view, element, coords, 2000)
                }
            }
        }
    }
    //  TODO: Handle when already at the definition
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
            return () => history.push(href)
        }
    }
    const uri = parseRepoURI(params.textDocument.uri)
    const href = toPrettyBlobURL({
        repoName: uri.repoName,
        revision: uri.revision,
        filePath: uri.filePath || 'FIXME_THIS_IS_A_BUG',
        position: { line: params.position.line + 1, character: params.position.character + 1 },
        viewState: 'def',
    })
    return () => history.push(href)
}

class Spinner {
    private spinner: HTMLElement
    constructor(coords: Coordinates) {
        this.spinner = document.createElement('div')
        this.spinner.textContent = 'loading...'
        this.spinner.style.backgroundColor = 'white'
        this.spinner.style.position = 'fixed'
        this.spinner.style.top = `${coords.y}px`
        this.spinner.style.left = `${coords.x}px`
        document.body.append(this.spinner)
    }
    public stop(): void {
        this.spinner.remove()
    }
}
