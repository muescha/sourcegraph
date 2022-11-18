import { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Remote } from 'comlink'
import * as H from 'history'

import { TextDocumentPositionParameters } from '@sourcegraph/client-api'
import { wrapRemoteObservable } from '@sourcegraph/shared/src/api/client/api/common'
import { FlatExtensionHostAPI } from '@sourcegraph/shared/src/api/contract'
import { parseRepoURI, toPrettyBlobURL, toURIWithPath } from '@sourcegraph/shared/src/util/url'

import { BlobInfo } from '../Blob'
import { Position, Range } from '@sourcegraph/shared/src/codeintel/scip'

export function contextMenu(
    codeintel: Remote<FlatExtensionHostAPI> | undefined,
    blobInfo: BlobInfo,
    history: H.History
): Extension {
    return EditorView.domEventHandlers({
        mouseover(event, view) {
            if (!event.metaKey) {
                return
            }
            console.log({ event })
        },
        contextmenu(event, view) {
            if (event.shiftKey) {
                return
            }
            const coords: Coordinates = {
                x: event.clientX,
                y: event.clientY,
            }
            const position = view.posAtCoords(coords)
            if (position === null) {
                return
            }
            if (!codeintel) {
                return
            }
            event.preventDefault()
            const cmLine = view.state.doc.lineAt(position)
            const line = cmLine.number - 1
            const uri = toURIWithPath(blobInfo)
            const character = position - cmLine.from
            const menu = document.createElement('div')
            const definition = document.createElement('div')
            definition.innerHTML = 'Go to definition'
            definition.classList.add('codeintel-contextmenu-item')
            definition.classList.add('codeintel-contextmenu-item-action')
            const definitionAction = goToDefinition(
                view,
                history,
                codeintel,
                {
                    position: { line, character },
                    textDocument: { uri },
                },
                coords
            )

            definition.addEventListener('click', () => {
                const spinner = new Spinner(coords)
                console.log('click!')
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
            console.log(menu)
            showTooltip(view, menu, coords)

            console.log(event)
        },
    })
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
    // eslint-disable-next-line ban/ban
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
    console.log('MULTIPLEDEFS')
    //  TODO: Handle when more than one result.
    return () => {}
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
