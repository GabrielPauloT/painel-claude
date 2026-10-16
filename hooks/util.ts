import type { PainelPasso, PainelStatus } from '../types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is PainelStatus {
  return value === 'pendente' || value === 'fazendo' || value === 'feito'
}

/** A lista que o modelo mandou para a ferramenta `passos`, ou o erro que ele vai ler. */
export function validarPassos(value: unknown): PainelPasso[] | string {
  if (!Array.isArray(value)) {
    return 'passos precisa ser uma lista de { texto, status }.'
  }
  const lista: PainelPasso[] = []
  for (const [i, item] of value.entries()) {
    if (!isRecord(item)) {
      return `passos[${i}] precisa ser um objeto { texto, status }.`
    }
    const texto = typeof item.texto === 'string' ? item.texto.trim() : ''
    if (texto === '') {
      return `passos[${i}].texto está vazio.`
    }
    if (!isStatus(item.status)) {
      return `passos[${i}].status precisa ser "pendente", "fazendo" ou "feito".`
    }
    lista.push({ texto: texto.slice(0, 200), status: item.status })
  }

  return lista.slice(0, 50)
}

/** Quantas linhas um texto tem, sem contar a quebra do fim. */
export function contarLinhas(text: string): number {
  if (text === '') {
    return 0
  }
  const n = text.split('\n').length

  return text.endsWith('\n') ? n - 1 : n
}

/** As linhas `+` e `-` de um `structuredPatch` do Edit ou do Write. */
export function contarPatch(patch: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0
  if (!Array.isArray(patch)) {
    return { added, removed }
  }
  for (const hunk of patch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) {
      continue
    }
    for (const line of hunk.lines) {
      if (typeof line !== 'string') {
        continue
      }
      if (line.startsWith('+')) {
        added += 1
      } else if (line.startsWith('-')) {
        removed += 1
      }
    }
  }

  return { added, removed }
}

export type Mudanca = { path: string; added: number; removed: number; isNew: boolean }

/** O que uma chamada de Edit, Write ou NotebookEdit mudou, lido do resultado dela. */
export function contarMudanca(tool: string, result: unknown): Mudanca | undefined {
  if (!isRecord(result) || result.staged === true) {
    return undefined
  }
  if (tool === 'Edit' || tool === 'Write') {
    if (typeof result.filePath !== 'string') {
      return undefined
    }
    const isNew = tool === 'Write' && result.type === 'create'
    const { added, removed } = contarPatch(result.structuredPatch)
    if (isNew && added === 0 && removed === 0) {
      const content = typeof result.content === 'string' ? result.content : ''

      return { path: result.filePath, added: contarLinhas(content), removed: 0, isNew }
    }

    return { path: result.filePath, added, removed, isNew }
  }
  if (tool === 'NotebookEdit') {
    if (typeof result.notebook_path !== 'string' || typeof result.error === 'string') {
      return undefined
    }
    const novo = typeof result.new_source === 'string' ? result.new_source : ''
    const velho = typeof result.old_source === 'string' ? result.old_source : ''

    return { path: result.notebook_path, added: contarLinhas(novo), removed: contarLinhas(velho), isNew: false }
  }

  return undefined
}

/** O caminho relativo à pasta da sessão, ou com `~` no lugar da home. */
export function encurtarCaminho(path: string, cwd: string, home: string): string {
  if (cwd !== '') {
    const base = cwd.endsWith('/') ? cwd : `${cwd}/`
    if (path.startsWith(base)) {
      return path.slice(base.length)
    }
  }
  if (home !== '' && path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`
  }

  return path
}

function primeiraLinha(text: string): string {
  return (text.split('\n').find(line => line.trim() !== '') ?? '').trim()
}

function hostDe(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** O ícone e a frase que o painel mostra para uma ferramenta rodando. */
export function descreverFerramenta(
  tool: string,
  input: Record<string, unknown>,
  caminho: (path: string) => string,
): { icon: string; label: string } {
  const texto = (key: string): string => {
    const value = input[key]

    return typeof value === 'string' ? value : ''
  }
  const arquivo = (key: string): string => {
    const path = texto(key)

    return path === '' ? 'arquivo' : caminho(path)
  }

  switch (tool) {
    case 'Read':
      return { icon: '⌕', label: `Lendo ${arquivo('file_path')}` }
    case 'Edit':
      return { icon: '✎', label: `Editando ${arquivo('file_path')}` }
    case 'Write':
      return { icon: '✎', label: `Escrevendo ${arquivo('file_path')}` }
    case 'NotebookEdit':
      return { icon: '✎', label: `Editando ${arquivo('notebook_path')}` }
    case 'Bash':
      return { icon: '$', label: texto('description') || primeiraLinha(texto('command')) || 'Rodando um comando' }
    case 'Grep':
      return { icon: '⌕', label: `Buscando “${texto('pattern')}”` }
    case 'Glob':
      return { icon: '⌕', label: `Procurando ${texto('pattern')}` }
    case 'WebFetch':
      return { icon: '⇣', label: `Abrindo ${hostDe(texto('url'))}` }
    case 'WebSearch':
      return { icon: '⌕', label: `Pesquisando “${texto('query')}”` }
    case 'Agent':
    case 'Task':
      return { icon: '◆', label: `Subagente: ${texto('description') || texto('subagent_type') || 'tarefa'}` }
    case 'Skill':
      return { icon: '▸', label: `Skill ${texto('skill')}` }
    case 'ToolSearch':
      return { icon: '▸', label: 'Carregando ferramentas' }
    case 'AskUserQuestion':
      return { icon: '?', label: 'Esperando sua resposta' }
    case 'Workflow':
      return { icon: '◆', label: 'Rodando um workflow' }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp !== null) {
    return { icon: '▸', label: `${mcp[1]} · ${mcp[2]}` }
  }

  return { icon: '▸', label: tool }
}

/** 12s, 1m 05s, 1h 03m. */
export function duracao(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** 950, 70k, 1,2M. */
export function tokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}M`
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`
  }

  return String(n)
}

/** $4,12 */
export function moeda(usd: number): string {
  return `$${usd.toFixed(2).replace('.', ',')}`
}

/** Corta o fim do texto para caber em `width` colunas. */
export function cortar(text: string, width: number): string {
  const chars = [...text]
  if (chars.length <= width) {
    return text
  }

  return width <= 1 ? chars.slice(0, Math.max(0, width)).join('') : `${chars.slice(0, width - 1).join('')}…`
}

/** Corta o começo do texto (bom para caminhos: o nome do arquivo fica). */
export function cortarInicio(text: string, width: number): string {
  const chars = [...text]
  if (chars.length <= width) {
    return text
  }

  return width <= 1 ? chars.slice(-Math.max(0, width)).join('') : `…${chars.slice(chars.length - (width - 1)).join('')}`
}

/** As últimas `max` linhas do texto quebrado em `width` colunas, com … se cortou o começo. */
export function linhasDoFim(text: string, width: number, max: number): string[] {
  const linhas: string[] = []
  for (const paragrafo of text.split('\n')) {
    let atual = ''
    for (const palavra of paragrafo.split(/\s+/)) {
      let resto = palavra
      while ([...resto].length > width) {
        if (atual !== '') {
          linhas.push(atual)
          atual = ''
        }
        linhas.push([...resto].slice(0, width).join(''))
        resto = [...resto].slice(width).join('')
      }
      if (resto === '') {
        continue
      }
      if (atual === '') {
        atual = resto
      } else if ([...atual].length + 1 + [...resto].length <= width) {
        atual = `${atual} ${resto}`
      } else {
        linhas.push(atual)
        atual = resto
      }
    }
    if (atual !== '') {
      linhas.push(atual)
    }
  }
  if (linhas.length <= max) {
    return linhas
  }
  const fim = linhas.slice(-max)
  fim[0] = cortar(`…${fim[0] ?? ''}`, width)

  return fim
}
