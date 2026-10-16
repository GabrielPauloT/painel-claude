import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallResult, TurnStepChunk } from 'claude-code'

import type { PainelArquivo, PainelContexto, PainelFase, PainelStatus, PainelTurno } from '../types'
import {
  contarMudanca,
  cortar,
  cortarInicio,
  descreverFerramenta,
  duracao,
  encurtarCaminho,
  isRecord,
  linhasDoFim,
  moeda,
  tokens,
  validarPassos,
} from './util'

type Motor = EngineInterface

const PANE = 'painel'
const TITULO = 'Painel'
/** Largura que o painel pede quando encaixa ao lado da conversa. */
const LARGURA = 42
const FERRAMENTA = 'passos'
const PASSOS = 'mcp__painel__passos'
/** Chave do `$.store`: false quando a pessoa fechou o painel. */
const PREF_ABERTO = 'aberto'
const TICK_MS = 500
const MAX_PENSAMENTO = 4000
const LINHAS_PENSAMENTO = 6
const MAX_ARQUIVOS = 10
const MAX_SUBAGENTES = 5

// As regras de uso moram na descrição da ferramenta, não só no prompt de sistema:
// onde uma organização gerencia o Claude Code, o prompt.compose de um plugin instalado não roda.
const DESCRICAO = [
  'Publica o plano no painel lateral que o usuário acompanha enquanto você trabalha.',
  'Em toda tarefa que use ferramentas, mesmo pequena, chame antes de começar com o plano inteiro: passos curtos (até uns 50 caracteres), em pt-BR, no infinitivo ("Ler a API de mods").',
  'A cada passo concluído, chame de novo: marque-o "feito" e o próximo "fazendo" na mesma chamada. Antes da resposta final, deixe como "feito" o que você concluiu.',
  'Mande sempre a lista inteira, na ordem, com o status de cada passo: "pendente", "fazendo" (no máximo um) ou "feito". Cada chamada substitui a lista anterior.',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    passos: {
      type: 'array',
      description: 'A lista completa de passos, na ordem.',
      items: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'O passo, curto, em pt-BR, no infinitivo ("Ler a API de mods").' },
          status: { type: 'string', enum: ['pendente', 'fazendo', 'feito'] },
        },
        required: ['texto', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['passos'],
  additionalProperties: false,
}

const SECAO = {
  id: 'painel:instrucoes',
  scope: 'session',
  text: [
    '# Painel lateral',
    `O usuário acompanha seu trabalho num painel lateral do Claude Code: a ferramenta em uso, o seu pensamento, os arquivos editados e o plano que você publica com ${PASSOS}, do jeito que a descrição dela pede (em toda tarefa que use ferramentas).`,
    '- Para mudar o conteúdo de arquivos, prefira Edit/Write a sed ou heredoc no Bash: o painel conta as linhas +/− pelas ferramentas Edit e Write.',
    `- Subagentes não precisam chamar ${PASSOS}.`,
  ].join('\n'),
} as const

const ICONE: Record<PainelStatus, string> = { feito: '✓', fazendo: '●', pendente: '○' }
const TITULO_DA_FASE: Record<PainelFase, string> = {
  pensando: 'Pensando',
  escrevendo: 'Escrevendo',
  ferramenta: 'Trabalhando',
  aguardando: 'Trabalhando',
}
const FRASE_DA_FASE: Record<PainelFase, string> = {
  pensando: 'Pensando…',
  escrevendo: 'Escrevendo a resposta…',
  ferramenta: 'Preparando a próxima ferramenta…',
  aguardando: 'Começando…',
}

const PARADO: PainelTurno = { isRunning: false, fase: 'aguardando', startedAt: 0 }

const turno = atom({ plugin: 'painel', key: 'turno' } as const, PARADO)
const relogio = atom({ plugin: 'painel', key: 'relogio' } as const, 0)
const agora = atom({ plugin: 'painel', key: 'agora' } as const, [])
const pensamento = atom({ plugin: 'painel', key: 'pensamento' } as const, '')
const passos = atom({ plugin: 'painel', key: 'passos' } as const, [])
const arquivos = atom({ plugin: 'painel', key: 'arquivos' } as const, [])
const contexto = atom({ plugin: 'painel', key: 'contexto' } as const, null)
const subagentes = atom({ plugin: 'painel', key: 'subagentes' } as const, [])

// O que o stream do turno vai acumulando entre um tique e outro do relógio.
// Variáveis do módulo recomeçam num reload; o que o painel desenha mora no $.state.
let cwd = ''
let home = ''
let ticker: Timer | undefined
let isPublicando = false
let fase: PainelFase = 'aguardando'
let fasePublicada: PainelFase | undefined
let pensando = ''
let isPensamentoSujo = false
let tokensAoVivo: number | undefined
let segundoPublicado = -1
const atividadeDoAgente = new Map<string, string>()

function caminho(path: string): string {
  return encurtarCaminho(path, cwd, home)
}

function doUso(
  context: { tokens?: number; window: number; percent?: number },
  cost: { usd: number } | undefined,
): PainelContexto {
  return {
    window: context.window,
    ...(context.tokens === undefined ? {} : { tokens: context.tokens }),
    ...(context.percent === undefined ? {} : { percent: context.percent }),
    ...(cost === undefined ? {} : { usd: cost.usd }),
  }
}

function comTokens(atual: PainelContexto | null, n: number): PainelContexto {
  const window = atual?.window ?? 0

  return {
    ...(atual ?? { window }),
    tokens: n,
    ...(window > 0 ? { percent: Math.round((n / window) * 100) } : {}),
  }
}

/** Lê um pedaço do stream do modelo: pensamento, texto, início de ferramenta, fim. */
function observar(chunk: TurnStepChunk): void {
  switch (chunk.kind) {
    case 'thinking':
      if (fase !== 'pensando') {
        pensando = ''
      }
      fase = 'pensando'
      pensando = (pensando + chunk.text).slice(-MAX_PENSAMENTO)
      isPensamentoSujo = true
      break
    case 'text':
      if (chunk.text.trim() !== '') {
        fase = 'escrevendo'
      }
      break
    case 'tool':
      fase = 'ferramenta'
      break
    case 'stop':
      if (chunk.usage !== null) {
        const u = chunk.usage
        tokensAoVivo = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
      }
      break
  }
}

/** Leva para o $.state o que o stream acumulou: tempo, pensamento, fase e tokens. */
async function publicar($: Motor): Promise<void> {
  if (isPublicando) {
    return
  }
  isPublicando = true
  try {
    const agoraMs = await $.clock.now()
    const segundo = Math.floor(agoraMs / 1000)
    if (segundo !== segundoPublicado) {
      segundoPublicado = segundo
      await update($, relogio, () => agoraMs)
    }
    if (isPensamentoSujo) {
      isPensamentoSujo = false
      const texto = pensando
      await update($, pensamento, () => texto)
    }
    if (fase !== fasePublicada) {
      const nova = fase
      fasePublicada = nova
      await update($, turno, t => (t.isRunning ? { ...t, fase: nova } : t))
    }
    if (tokensAoVivo !== undefined) {
      const n = tokensAoVivo
      tokensAoVivo = undefined
      await update($, contexto, c => comTokens(c, n))
    }
  } catch {
    // O próximo tique tenta de novo.
  } finally {
    isPublicando = false
  }
}

function iniciarRelogio($: Motor): void {
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => {
    void publicar($)
  })
}

function pararRelogio(): void {
  ticker?.cancel()
  ticker = undefined
}

async function atualizarSubagentes($: Motor): Promise<void> {
  const vivos = (await $.agent.list()).filter(
    a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting',
  )
  for (const id of atividadeDoAgente.keys()) {
    if (!vivos.some(a => a.id === id)) {
      atividadeDoAgente.delete(id)
    }
  }
  await update($, subagentes, () =>
    vivos.map(a => {
      const atividade = atividadeDoAgente.get(a.id)

      return { id: a.id, type: a.type, description: a.description, ...(atividade === undefined ? {} : { atividade }) }
    }),
  )
}

async function registrarEdicao($: Motor, tool: string, result: unknown): Promise<void> {
  const mudanca = contarMudanca(tool, result)
  if (mudanca === undefined) {
    return
  }
  const at = await $.clock.now()
  const path = caminho(mudanca.path)
  await update($, arquivos, lista => {
    const antes = lista.find(a => a.path === path)
    const junto: PainelArquivo = {
      path,
      added: (antes?.added ?? 0) + mudanca.added,
      removed: (antes?.removed ?? 0) + mudanca.removed,
      isNew: (antes?.isNew ?? false) || mudanca.isNew,
      at,
    }

    return [junto, ...lista.filter(a => a.path !== path)].slice(0, 200)
  })
}

async function zerar($: Motor): Promise<void> {
  pararRelogio()
  fase = 'aguardando'
  fasePublicada = undefined
  pensando = ''
  isPensamentoSujo = false
  tokensAoVivo = undefined
  atividadeDoAgente.clear()
  await update($, turno, () => PARADO)
  await update($, agora, () => [])
  await update($, pensamento, () => '')
  await update($, passos, () => [])
  await update($, arquivos, () => [])
  await update($, subagentes, () => [])
  await update($, contexto, () => null)
}

/** A resposta da ferramenta `passos`: guarda a lista, ou devolve o erro que o modelo vai ler. */
async function responderPassos($: Motor, value: unknown, agentId: string | undefined): Promise<ToolCallResult> {
  const lista = validarPassos(value)
  if (typeof lista === 'string') {
    return { deny: lista }
  }
  if (agentId !== undefined) {
    return { result: 'Não precisa: o painel mostra só o plano da conversa principal. Não chame de novo.' }
  }
  await update($, passos, () => lista)
  const feitos = lista.filter(p => p.status === 'feito').length
  const atual = lista.find(p => p.status === 'fazendo')

  return {
    result: `Painel atualizado: ${feitos}/${lista.length} feitos${atual === undefined ? '' : `; agora: ${atual.texto}`}.`,
  }
}

function somar(lista: readonly PainelArquivo[]): { added: number; removed: number } {
  return lista.reduce((t, a) => ({ added: t.added + a.added, removed: t.removed + a.removed }), { added: 0, removed: 0 })
}

function textoDoContador(a: { added: number; removed: number }): string {
  return a.removed > 0 ? `+${a.added} −${a.removed}` : `+${a.added}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    try {
      home = (await $.env.get('HOME')) ?? ''
    } catch {
      home = ''
    }
    if (e.isInteractive) {
      await $.command.register({
        name: 'painel',
        description: 'Abre ou fecha o painel lateral; "/painel limpar" zera passos e arquivos',
        argumentHint: '[limpar]',
        immediate: true,
      })
      await $.tool.register({ name: FERRAMENTA, description: DESCRICAO, inputSchema: SCHEMA, isDeferred: false })
      try {
        const uso = await $.session.usage()
        await update($, contexto, () => doUso(uso.context, uso.cost))
      } catch {
        // Sem números ainda: o session.measure do fim do turno traz.
      }
      if ((await $.store.get(PREF_ABERTO)) !== false) {
        void $.ui.open({ id: PANE, title: TITULO, columns: LARGURA })
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await zerar($)
    }

    return next(e)
  })

  on('command.run', { command: 'painel' }, async ($, e) => {
    if (e.args.trim() === 'limpar') {
      await update($, passos, () => [])
      await update($, arquivos, () => [])

      return { text: 'Painel zerado: passos e arquivos limpos.' }
    }
    const isAberto = (await $.ui.panes()).some(p => p.id === PANE)
    if (isAberto) {
      await $.store.set(PREF_ABERTO, false)
      await $.ui.close({ id: PANE })

      return { text: 'Painel fechado. /painel abre de novo.' }
    }
    await $.store.set(PREF_ABERTO, true)
    const aberto = await $.ui.open({ id: PANE, title: TITULO, columns: LARGURA })

    return { text: aberto.isPlaced ? 'Painel aberto.' : `Painel aberto, esperando espaço: ${aberto.reason}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await $.store.set(PREF_ABERTO, false)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!e.tools.includes(PASSOS)) {
      return out
    }

    return { sections: [...out.sections.filter(s => s.id !== SECAO.id), SECAO] }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      void atualizarSubagentes($).catch(() => {})

      return next(e)
    }
    const inicio = await $.clock.now()
    fase = 'pensando'
    fasePublicada = 'pensando'
    pensando = ''
    isPensamentoSujo = false
    tokensAoVivo = undefined
    segundoPublicado = Math.floor(inicio / 1000)
    await update($, turno, (t): PainelTurno => ({ ...t, isRunning: true, fase: 'pensando', startedAt: inicio }))
    await update($, pensamento, () => '')
    await update($, agora, () => [])
    await update($, relogio, () => inicio)
    iniciarRelogio($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) {
      return yield* stream
    }
    for await (const chunk of stream) {
      try {
        observar(chunk)
      } catch {
        // Ler o stream nunca atrapalha o stream.
      }
      yield chunk
    }

    return await stream.result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      atividadeDoAgente.delete(e.agentId)
      void atualizarSubagentes($).catch(() => {})

      return next(e)
    }
    pararRelogio()
    fase = 'aguardando'
    fasePublicada = undefined
    pensando = ''
    isPensamentoSujo = false
    tokensAoVivo = undefined
    await update(
      $,
      turno,
      (t): PainelTurno => ({ ...t, isRunning: false, fase: 'aguardando', lastDurationMs: e.durationMs }),
    )
    await update($, pensamento, () => '')
    await update($, agora, () => [])

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, contexto, () => doUso(e.context, e.cost))

    return next(e)
  })

  // Toda ferramenta passa aqui. A `passos` o painel responde; as outras viram a linha de
  // AGORA e, se mexeram em arquivo, entram em ARQUIVOS. O nome da `passos` fica fora da
  // tabela de tipos de MCP que a engine gera, então a comparação é por String(e.tool).
  on('tool.call', async ($, e, next) => {
    const nome = String(e.tool)
    if (nome === PASSOS) {
      return responderPassos($, (e as Record<string, unknown>).passos, e.agentId)
    }
    const id = e.tool_use_id
    const { icon, label } = descreverFerramenta(nome, e as Record<string, unknown>, caminho)
    if (e.agentId === undefined) {
      fase = 'ferramenta'
      const startedAt = await $.clock.now()
      await update($, agora, lista => [...lista.filter(a => a.id !== id), { id, icon, label, startedAt }])
    } else {
      atividadeDoAgente.set(e.agentId, `${icon} ${label}`)
      void atualizarSubagentes($).catch(() => {})
    }
    try {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        await registrarEdicao($, nome, ran.result).catch(() => {})
      }

      return ran
    } finally {
      if (e.agentId === undefined) {
        await update($, agora, lista => lista.filter(a => a.id !== id)).catch(() => {})
      }
    }
  }).catch(async ($, e, next) =>
    String(e.tool) === PASSOS && !next.called
      ? { deny: 'O painel não conseguiu guardar os passos agora; siga sem ele.' }
      : next(e),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.component !== 'Pane') {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const [t, agoraMs, ativas, pens, ps, arqs, ctx, subs] = await Promise.all([
      read($, turno),
      read($, relogio),
      read($, agora),
      read($, pensamento),
      read($, passos),
      read($, arquivos),
      read($, contexto),
      read($, subagentes),
    ])
    const largura = Math.max(12, e.props.bodyColumns - 1)
    const feitos = ps.filter(p => p.status === 'feito').length
    const total = somar(arqs)
    const decorrido = t.isRunning ? Math.max(0, agoraMs - t.startedAt) : 0
    const pct =
      ctx?.percent ??
      (ctx?.tokens !== undefined && ctx.window > 0 ? Math.round((ctx.tokens / ctx.window) * 100) : undefined)

    // Acima do prompt (fora do fullscreen) o painel vira uma linha só.
    if (e.props.placement === 'inline') {
      const partes = [
        t.isRunning
          ? `● ${ativas.at(-1)?.label ?? TITULO_DA_FASE[t.fase]} · ${duracao(decorrido)}`
          : t.lastDurationMs === undefined
            ? '○ Aguardando'
            : `○ Pronto · ${duracao(t.lastDurationMs)}`,
        ps.length > 0 ? `☰ ${feitos}/${ps.length}` : '',
        arqs.length > 0 ? `✎ ${arqs.length} arq. ${textoDoContador(total)}` : '',
        pct === undefined ? '' : `ctx ${pct}%`,
      ].filter(p => p !== '')

      return (
        <Box>
          <Text wrap="truncate-end">{partes.join('   ')}</Text>
        </Box>
      )
    }

    const contador = (a: { added: number; removed: number }) => (
      <Box flexShrink={0}>
        <Text color="success">{`+${a.added}`}</Text>
        {a.removed > 0 && <Text color="error">{` −${a.removed}`}</Text>}
      </Box>
    )

    const cabecalho = t.isRunning ? (
      <Box>
        <Text color="claude">● </Text>
        <Text weight="bold">{TITULO_DA_FASE[t.fase]}</Text>
        <Text dimColor>{` · ${duracao(decorrido)}`}</Text>
      </Box>
    ) : (
      <Box>
        <Text dimColor>○ </Text>
        <Text weight="bold">{t.lastDurationMs === undefined ? 'Aguardando' : 'Pronto'}</Text>
        {t.lastDurationMs !== undefined && <Text dimColor>{` · turno de ${duracao(t.lastDurationMs)}`}</Text>}
      </Box>
    )

    const isVazio = !t.isRunning && ps.length === 0 && arqs.length === 0 && subs.length === 0

    const secaoAgora = t.isRunning && (
      <Box flexDirection="column">
        <Text weight="bold">AGORA</Text>
        {ativas.length === 0 ? (
          <Text dimColor>{FRASE_DA_FASE[t.fase]}</Text>
        ) : (
          ativas.slice(-4).map(a => {
            const tempo = agoraMs - a.startedAt >= 2000 ? ` · ${duracao(agoraMs - a.startedAt)}` : ''

            return <Text>{cortar(`${a.icon} ${a.label}${tempo}`, largura)}</Text>
          })
        )}
      </Box>
    )

    const linhas = t.isRunning ? linhasDoFim(pens, largura, LINHAS_PENSAMENTO) : []
    const secaoPensamento = linhas.length > 0 && (
      <Box flexDirection="column">
        <Text weight="bold">PENSAMENTO</Text>
        {linhas.map(linha => (
          <Text dimColor italic>
            {linha}
          </Text>
        ))}
      </Box>
    )

    const secaoPassos = ps.length > 0 && (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text weight="bold">PASSOS</Text>
          <Text dimColor>{`${feitos}/${ps.length}`}</Text>
        </Box>
        {ps.map(p => (
          <Box>
            <Box flexShrink={0}>
              {p.status === 'feito' && <Text color="success">{`${ICONE.feito} `}</Text>}
              {p.status === 'fazendo' && <Text color="claude">{`${ICONE.fazendo} `}</Text>}
              {p.status === 'pendente' && <Text dimColor>{`${ICONE.pendente} `}</Text>}
            </Box>
            {p.status === 'feito' && <Text dimColor>{p.texto}</Text>}
            {p.status === 'fazendo' && <Text weight="bold">{p.texto}</Text>}
            {p.status === 'pendente' && <Text>{p.texto}</Text>}
          </Box>
        ))}
      </Box>
    )

    const secaoArquivos = arqs.length > 0 && (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text weight="bold">{`ARQUIVOS · ${arqs.length}`}</Text>
          {contador(total)}
        </Box>
        {arqs.slice(0, MAX_ARQUIVOS).map(a => (
          <Box justifyContent="space-between">
            <Text>{cortarInicio(a.path, largura - textoDoContador(a).length - 1)}</Text>
            {contador(a)}
          </Box>
        ))}
        {arqs.length > MAX_ARQUIVOS && <Text dimColor>{`+ ${arqs.length - MAX_ARQUIVOS} outros`}</Text>}
      </Box>
    )

    const secaoSubagentes = subs.length > 0 && (
      <Box flexDirection="column">
        <Text weight="bold">{`SUBAGENTES · ${subs.length}`}</Text>
        {subs.slice(0, MAX_SUBAGENTES).map(s => (
          <Box flexDirection="column">
            <Text>{cortar(`◆ ${s.description || s.type}`, largura)}</Text>
            {s.atividade !== undefined && <Text dimColor>{cortar(`  ${s.atividade}`, largura)}</Text>}
          </Box>
        ))}
      </Box>
    )

    const temContexto = ctx !== null && (ctx.tokens !== undefined || ctx.usd !== undefined)
    const sufixo =
      ctx?.tokens !== undefined && pct !== undefined ? `  ${pct}% · ${tokens(ctx.tokens)}/${tokens(ctx.window)}` : ''
    const larguraDaBarra = Math.max(6, largura - sufixo.length)
    const cheio = pct === undefined ? 0 : Math.round((larguraDaBarra * Math.min(100, Math.max(0, pct))) / 100)
    const corDaBarra = pct !== undefined && pct >= 85 ? 'error' : pct !== undefined && pct >= 70 ? 'warning' : 'claude'
    const secaoContexto = temContexto && (
      <Box flexDirection="column">
        <Text weight="bold">CONTEXTO</Text>
        {sufixo !== '' && (
          <Box>
            {cheio > 0 && <Text color={corDaBarra}>{'█'.repeat(cheio)}</Text>}
            {cheio < larguraDaBarra && <Text dimColor>{'░'.repeat(larguraDaBarra - cheio)}</Text>}
            <Text>{sufixo}</Text>
          </Box>
        )}
        {ctx.usd !== undefined && (
          <Box justifyContent="space-between">
            <Text dimColor>custo API (estimado)</Text>
            <Text>{moeda(ctx.usd)}</Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {cabecalho}
        {isVazio && (
          <Text dimColor>
            Quando eu começar a trabalhar, aparece aqui o que estou fazendo, meu pensamento, os passos e os arquivos
            editados.
          </Text>
        )}
        {secaoAgora}
        {secaoPensamento}
        {secaoPassos}
        {secaoArquivos}
        {secaoSubagentes}
        {secaoContexto}
      </Box>
    )
  })

  // A chamada da ferramenta de passos no histórico: uma linha só, com o resumo.
  on('ui.render', { component: 'ToolUse', props: { tool: PASSOS } }, async ($, e, next) => {
    if (e.component !== 'ToolUse' || e.props.isErrored) {
      return next(e)
    }
    const lista = validarPassos(isRecord(e.props.input) ? e.props.input.passos : undefined)
    if (typeof lista === 'string') {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const feitos = lista.filter(p => p.status === 'feito').length
    const atual = lista.find(p => p.status === 'fazendo')
    const proximo = lista.find(p => p.status === 'pendente')
    const destaque =
      atual !== undefined
        ? ` · agora: ${atual.texto}`
        : proximo !== undefined
          ? ` · próximo: ${proximo.texto}`
          : ' · tudo feito'

    return (
      <Box>
        <Text color="claude">☰ </Text>
        <Text weight="bold">{`Passos ${feitos}/${lista.length}`}</Text>
        <Text dimColor wrap="truncate-end">
          {destaque}
        </Text>
      </Box>
    )
  })

  // O resultado dela não acrescenta nada à linha de cima.
  on('ui.render', { component: 'ToolResult', props: { tool: PASSOS } }, async ($, e, next) => {
    if (e.component !== 'ToolResult' || e.props.isErrored) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}
