/** Como cada passo do plano está agora. */
export type PainelStatus = 'pendente' | 'fazendo' | 'feito'

/** Um passo do plano que o modelo publica com a ferramenta `passos`. */
export type PainelPasso = { texto: string; status: PainelStatus }

/** Um arquivo que o Edit, o Write ou o NotebookEdit mudou nesta sessão. */
export type PainelArquivo = {
  /** O caminho como o painel mostra: relativo à pasta da sessão, ou com `~`. */
  path: string
  added: number
  removed: number
  /** True quando o Write criou o arquivo. */
  isNew: boolean
  /** Quando foi mudado pela última vez, em milissegundos de `$.clock.now()`. */
  at: number
}

/** Uma ferramenta que a conversa principal está rodando agora. */
export type PainelAtividade = { id: string; icon: string; label: string; startedAt: number }

/** O que a conversa principal está fazendo dentro do turno. */
export type PainelFase = 'aguardando' | 'pensando' | 'escrevendo' | 'ferramenta'

export type PainelTurno = {
  isRunning: boolean
  fase: PainelFase
  /** Quando o turno em andamento (ou o último) começou. */
  startedAt: number
  /** Quanto durou o último turno terminado, em milissegundos. */
  lastDurationMs?: number
}

/** A janela de contexto e o custo, como a statusline mostra. */
export type PainelContexto = { tokens?: number; window: number; percent?: number; usd?: number }

/** Um subagente que está rodando, com a ferramenta que ele usa agora. */
export type PainelSubagente = { id: string; type: string; description: string; atividade?: string }

declare module 'claude-code' {
  interface PluginState {
    painel: {
      turno: PainelTurno
      /** A hora que o relógio do painel marcou por último (redesenha o tempo). */
      relogio: number
      agora: PainelAtividade[]
      /** O fim do pensamento que está chegando. */
      pensamento: string
      passos: PainelPasso[]
      arquivos: PainelArquivo[]
      contexto: PainelContexto | null
      subagentes: PainelSubagente[]
    }
  }
}
