import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/solidity/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

monaco.editor.defineTheme('sol-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'c4b5fd' },
    { token: 'type', foreground: '7dd3fc' },
    { token: 'number', foreground: 'fcd34d' },
    { token: 'string', foreground: '86efac' },
    { token: 'comment', foreground: '5b647e', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#0d0f17',
    'editor.lineHighlightBackground': '#161a28',
    'editorLineNumber.foreground': '#3a4160',
    'editorLineNumber.activeForeground': '#a5b4fc',
    'editorGutter.background': '#0d0f17',
    'editor.selectionBackground': '#3b3f8a88',
    'editorIndentGuide.background1': '#1c2133',
  },
})

export function createEditor(el: HTMLElement, value: string) {
  return monaco.editor.create(el, {
    value,
    language: 'sol',
    theme: 'sol-dark',
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'all',
    padding: { top: 10 },
    tabSize: 4,
    smoothScrolling: true,
  })
}

export { monaco }
