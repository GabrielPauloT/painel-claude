import type { ToolCallArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PASSOS = 'mcp__painel__passos'

const PLANO = [
  { texto: 'Ler a API de mods', status: 'feito' },
  { texto: 'Escrever o manifesto', status: 'feito' },
  { texto: 'Escrever o register.tsx', status: 'fazendo' },
  { texto: 'Validar e testar', status: 'pendente' },
  { texto: 'Instalar de vez', status: 'pendente' },
]

/**
 * A chamada da ferramenta do painel. O nome dela fica fora da tabela de tipos de MCP que a
 * engine gera (que só lista os servidores conectados), daí a conversão.
 */
function passosCom(passos: unknown): ToolCallArgs {
  return { tool: PASSOS, passos } as unknown as ToolCallArgs
}

/** Desenha o painel no terminal e devolve o texto que ele mostra. */
async function painel($: Engine, placement: 'dock' | 'inline' = 'dock'): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'painel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'painel',
    props: {
      title: 'Painel',
      isFocused: false,
      bodyColumns: 40,
      placement,
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
    viewport: { columns: 200, rows: 60, isFullscreen: placement === 'dock' },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.map(t => t.text).join('\n')
}

test('a lista de passos aparece no painel com quantos já foram feitos', async ($, on) => {
  mock.clock(on)
  const ran = await $.tool.call(passosCom(PLANO))
  expect(ran.deny).toBeUndefined()

  const text = await painel($)
  expect(text).toContain('PASSOS')
  expect(text).toContain('2/5')
  expect(text).toContain('Escrever o register.tsx')
})

test('uma lista de passos inválida volta como erro para o modelo', async ($, on) => {
  mock.clock(on)
  const ran = await $.tool.call(passosCom([{ texto: '', status: 'talvez' }]))

  expect(ran.deny).toContain('passos')
})

test('um Edit soma as linhas + e − do arquivo', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Edit' }, ($, e) => ({
    result: {
      filePath: e.file_path,
      oldString: e.old_string,
      newString: e.new_string,
      originalFile: 'a\nb\n',
      structuredPatch: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, lines: [' a', '-b', '+c', '+d', '+e'] },
      ],
      userModified: false,
      replaceAll: false,
    },
  }))
  await $.tool.call({ tool: 'Edit', file_path: '/srv/app/src/app.ts', old_string: 'b', new_string: 'c\nd\ne' })

  const text = await painel($)
  expect(text).toContain('ARQUIVOS')
  expect(text).toContain('app.ts')
  expect(text).toContain('+3')
  expect(text).toContain('−1')
})

test('um Write de arquivo novo conta todas as linhas como adicionadas', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Write' }, ($, e) => ({
    result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
  }))
  await $.tool.call({ tool: 'Write', file_path: '/srv/app/novo.md', content: 'um\ndois\ntrês\n' })

  const text = await painel($)
  expect(text).toContain('novo.md')
  expect(text).toContain('+3')
})

test('a ferramenta em execução aparece em AGORA', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('tool.call', { tool: 'Bash' }, async () => {
    await gate
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.turn.start({ text: 'roda os testes', turnId: 't1' })
  const running = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Rodar os testes' })
  await clock.settle()

  const text = await painel($)
  expect(text).toContain('AGORA')
  expect(text).toContain('Rodar os testes')

  release()
  await running
})

test('o pensamento aparece ao vivo enquanto o turno roda', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'thinking' as const, index: 0, text: 'vou contar as linhas ' }
    yield { kind: 'thinking' as const, index: 0, text: 'de cada patch' }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  await $.turn.start({ text: 'oi', turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const chunk of stream) {
    expect(chunk.kind).toBe('thinking')
  }
  await stream.result
  await clock.advance(1000)

  const text = await painel($)
  expect(text).toContain('PENSAMENTO')
  expect(text).toContain('de cada patch')
})

test('quando o turno termina o painel diz que está pronto e some o pensamento', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'oi', turnId: 't1' })
  await clock.advance(65_000)
  await $.turn.complete({ answer: 'feito', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const text = await painel($)
  expect(text).toContain('Pronto')
  expect(text).toContain('1m 05s')
  expect(text).not.toContain('PENSAMENTO')
})

test('o contexto mostra a porcentagem, os tokens e o custo', async ($, on) => {
  mock.clock(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 70_000, window: 200_000, percent: 35 },
    rateLimits: [],
    cost: { usd: 4.12 },
    changed: ['context', 'cost'],
  })

  const text = await painel($)
  expect(text).toContain('CONTEXTO')
  expect(text).toContain('35%')
  expect(text).toContain('70k/200k')
  expect(text).toContain('$4,12')
})

test('o prompt de sistema ganha a instrução do painel quando a ferramenta é oferecida', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const out = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', PASSOS],
    outputStyle: null,
    traits: [],
  })

  const mine = out.sections.find(s => s.id === 'painel:instrucoes')
  expect(mine?.scope).toBe('session')
  expect(mine?.text).toContain(PASSOS)
})

test('sem a ferramenta de passos na lista, o prompt de sistema fica como estava', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const out = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash'],
    outputStyle: null,
    traits: [],
  })

  expect(out.sections.map(s => s.id)).toEqual(['intro'])
})

test('encaixado acima do prompt, o painel vira um resumo curto', async ($, on) => {
  mock.clock(on)
  await $.tool.call(passosCom(PLANO))

  const text = await painel($, 'inline')
  expect(text).toContain('2/5')
  expect(text).not.toContain('PASSOS')
})

test('um subagente rodando aparece com o que está fazendo', async ($, on) => {
  const clock = mock.clock(on)
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Procurar skills', type: 'Explore', status: 'running' as const }],
  }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'procura', turnId: 't9', agentId: 'a1' })
  await clock.settle()

  const text = await painel($)
  expect(text).toContain('SUBAGENTES · 1')
  expect(text).toContain('Procurar skills')
})

test('o resultado da ferramenta de passos some do histórico', async $ => {
  const ui = await $.ui.mount({
    plugin: 'painel',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'toolu_2',
    props: { tool_use_id: 'toolu_2', tool: PASSOS, output: 'Painel atualizado: 2/5 feitos.', isErrored: false },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  expect(texts).toHaveLength(0)
})

test('a chamada da ferramenta de passos vira uma linha curta no histórico', async $ => {
  const ui = await $.ui.mount({
    plugin: 'painel',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_1',
    props: {
      tool_use_id: 'toolu_1',
      tool: PASSOS,
      input: { passos: PLANO },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  const text = texts.map(t => t.text).join(' ')
  expect(text).toContain('Passos 2/5')
  expect(text).toContain('Escrever o register.tsx')
})

/** Roda um Bash qualquer e devolve o que o modelo leria depois do resultado (o `context`). */
async function contextoDoBash($: Engine, agentId?: string): Promise<readonly string[]> {
  const args = { tool: 'Bash', command: 'true', description: 'Rodar algo', ...(agentId === undefined ? {} : { agentId }) }
  const ran = await $.tool.call(args as unknown as ToolCallArgs)

  return ran.deny === undefined ? (ran.context ?? []) : []
}

test('seis ferramentas sem mexer nos passos trazem um lembrete na sexta, e só nela', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call(passosCom(PLANO))

  const contextos: Array<readonly string[]> = []
  for (let i = 0; i < 7; i++) {
    contextos.push(await contextoDoBash($))
  }

  expect(contextos.slice(0, 5).flat()).toEqual([])
  expect(contextos[5]?.join(' ')).toContain(PASSOS)
  expect(contextos[6]).toEqual([])
})

test('atualizar os passos zera a contagem do lembrete', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call(passosCom(PLANO))

  const contextos: Array<readonly string[]> = []
  for (let i = 0; i < 5; i++) {
    contextos.push(await contextoDoBash($))
  }
  await $.tool.call(passosCom(PLANO))
  for (let i = 0; i < 5; i++) {
    contextos.push(await contextoDoBash($))
  }

  expect(contextos.flat()).toEqual([])
})

test('ferramentas de subagente não contam para o lembrete', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call(passosCom(PLANO))

  const contextos: Array<readonly string[]> = []
  for (let i = 0; i < 6; i++) {
    contextos.push(await contextoDoBash($, 'a1'))
  }

  expect(contextos.flat()).toEqual([])
})

test('fora de sessão interativa não há lembrete, porque lá a ferramenta de passos não existe', async ($, on) => {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.session.start({ cwd: '/srv/app', surface: null, isInteractive: false })

  const contextos: Array<readonly string[]> = []
  for (let i = 0; i < 6; i++) {
    contextos.push(await contextoDoBash($))
  }

  expect(contextos.flat()).toEqual([])
})
