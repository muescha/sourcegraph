import { EditorSelection, Extension, Line } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'
import { Remote } from 'comlink'
import * as H from 'history'

import { TextDocumentPositionParameters } from '@sourcegraph/client-api'
import { wrapRemoteObservable } from '@sourcegraph/shared/src/api/client/api/common'
import { FlatExtensionHostAPI } from '@sourcegraph/shared/src/api/contract'
import { Occurrence, Position, Range } from '@sourcegraph/shared/src/codeintel/scip'
import { parseRepoURI, toPrettyBlobURL, toURIWithPath } from '@sourcegraph/shared/src/util/url'

import { BlobInfo } from '../Blob'

import { HighlightIndex, syntaxHighlight } from './highlight'
import { isInteractiveOccurrence } from './tokens-as-links'

import styles from './context-menu.module.scss'
import { shouldScrollIntoView } from './linenumbers'

function occurrenceAtPosition(
    view: EditorView,
    position: Position
): { occurrence: Occurrence; position: Position } | undefined {
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
            return { occurrence, position }
        }
    }
    return
}

function closestOccurrence(line: number, table: HighlightIndex, position: Position): Occurrence | undefined {
    const candidates: [Occurrence, number][] = []
    let index = table.lineIndex[line] ?? -1
    for (
        ;
        index >= 0 && index < table.occurrences.length && table.occurrences[index].range.start.line === line;
        index++
    ) {
        const occurrence = table.occurrences[index]
        if (!isInteractiveOccurrence(occurrence)) {
            continue
        }
        candidates.push([occurrence, occurrence.range.characterDistance(position)])
    }
    candidates.sort(([, a], [, b]) => a - b)
    if (candidates.length > 0) {
        return candidates[0][0]
    }
    return undefined
}

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
    const occurrence = occurrenceAtPosition(view, position)
    if (!occurrence) {
        return
    }
    return { ...occurrence, coords }
}
function goToDefinitionAtOccurrence(
    view: EditorView,
    blobInfo: BlobInfo,
    history: H.History,
    codeintel: Remote<FlatExtensionHostAPI>,
    position: Position,
    occurrence: Occurrence,
    coords: Coordinates
): Promise<() => void> {
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
    return goToDefinitionAtOccurrence(view, blobInfo, history, codeintel, position, occurrence, coords)
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
    return { position: scipPositionAtCodemirrorPosition(view, position), coords }
}

function scipPositionAtCodemirrorPosition(view: EditorView, position: number): Position {
    const cmLine = view.state.doc.lineAt(position)
    const line = cmLine.number - 1
    const character = position - cmLine.from
    return new Position(line, character)
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

function closesByDistance(line: number, table: OccIndex)

export function contextMenu(
    codeintel: Remote<FlatExtensionHostAPI> | undefined,
    blobInfo: BlobInfo,
    history: H.History
): Extension {
    document.removeEventListener('keydown', globalEventHandler)
    document.addEventListener('keydown', globalEventHandler)
    document.removeEventListener('keyup', globalEventHandler)
    document.addEventListener('keyup', globalEventHandler)

    const scrollLineIntoView = (view: EditorView, line: Line): boolean => {
        if (shouldScrollIntoView(view, { line: line.number })) {
            view.dispatch({
                effects: EditorView.scrollIntoView(line.from, { y: 'nearest' }),
            })
            return true
        }
        return false
    }
    const selectOccurrence = (view: EditorView, occurrence: Occurrence): void => {
        const startLine = view.state.doc.line(occurrence.range.start.line + 1)
        const endLine = view.state.doc.line(occurrence.range.end.line + 1)
        const start = startLine.from + occurrence.range.start.character
        const end = endLine.from + occurrence.range.end.character
        view.dispatch({ selection: EditorSelection.range(start, end) })
        const lineAbove = view.state.doc.line(Math.min(view.state.doc.lines, startLine.number + 2))
        if (scrollLineIntoView(view, lineAbove)) {
            return
        }
        const lineBelow = view.state.doc.line(Math.max(0, startLine.number - 2))
        scrollLineIntoView(view, lineBelow)
    }

    return [
        keymap.of([
            {
                key: 'Space',
                run(view) {
                    return true
                },
            },
            {
                key: 'Enter',
                run(view) {
                    if (!codeintel) {
                        return false
                    }
                    const position = scipPositionAtCodemirrorPosition(view, view.state.selection.main.from)
                    const atEvent = occurrenceAtPosition(view, position)
                    if (!atEvent) {
                        return false
                    }
                    const { occurrence } = atEvent
                    const cmLine = view.state.doc.line(occurrence.range.start.line + 1)
                    const cmPos = cmLine.from + occurrence.range.start.character
                    const rect = view.coordsAtPos(cmPos)
                    const coords: Coordinates = rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 }
                    const spinner = new Spinner(coords)
                    goToDefinitionAtOccurrence(view, blobInfo, history, codeintel, position, occurrence, coords)
                        .then(
                            action => action(),
                            () => {}
                        )
                        .finally(() => spinner.stop())
                    return true
                },
            },
            {
                key: 'Mod-ArrowRight',
                run() {
                    history.goForward()
                    return true
                },
            },
            {
                key: 'Mod-ArrowLeft',
                run() {
                    history.goBack()
                    return true
                },
            },
            {
                key: 'ArrowLeft',
                run(view) {
                    const position = scipPositionAtCodemirrorPosition(view, view.state.selection.main.from)
                    const table = view.state.facet(syntaxHighlight)
                    const line = position.line
                    let index = table.lineIndex[line + 1] ?? -1
                    index-- // Start with the last occurrence of this line
                    for (; index >= 0 && table.occurrences[index].range.start.line === line; index--) {
                        const occurrence = table.occurrences[index]
                        if (!isInteractiveOccurrence(occurrence)) {
                            continue
                        }
                        console.log({ position, occurrence: occurrence.range })
                        if (occurrence.range.start.character >= position.character) {
                            console.log('boom')
                            continue
                        }
                        selectOccurrence(view, occurrence)
                        return true
                    }
                    return true
                },
            },
            {
                key: 'ArrowRight',
                run(view) {
                    const position = scipPositionAtCodemirrorPosition(view, view.state.selection.main.from)
                    const table = view.state.facet(syntaxHighlight)
                    const line = position.line
                    let index = table.lineIndex[line] ?? -1
                    for (
                        ;
                        index >= 0 &&
                        index < table.occurrences.length &&
                        table.occurrences[index].range.start.line === line;
                        index++
                    ) {
                        const occurrence = table.occurrences[index]
                        if (occurrence.range.start.character <= position.character) {
                            continue
                        }
                        if (!isInteractiveOccurrence(occurrence)) {
                            continue
                        }
                        selectOccurrence(view, occurrence)
                        return true
                    }
                    return true
                },
            },
            {
                key: 'ArrowDown',
                run(view) {
                    const position = scipPositionAtCodemirrorPosition(view, view.state.selection.main.from)
                    const table = view.state.facet(syntaxHighlight)
                    for (let line = position.line + 1; line < table.lineIndex.length; line++) {
                        const occurrence = closestOccurrence(line, table, position)
                        if (occurrence) {
                            selectOccurrence(view, occurrence)
                            return true
                        }
                    }
                    return true
                },
            },
            {
                key: 'ArrowUp',
                run(view) {
                    const position = scipPositionAtCodemirrorPosition(view, view.state.selection.main.from)
                    const table = view.state.facet(syntaxHighlight)
                    for (let line = position.line - 1; line > 0; line--) {
                        const occurrence = closestOccurrence(line, table, position)
                        if (occurrence) {
                            selectOccurrence(view, occurrence)
                            return true
                        }
                    }
                    return true
                },
            },
        ]),
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
