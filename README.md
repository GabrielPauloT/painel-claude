# painel: barra lateral do Claude Code

Mod do Claude Code (feito na 2.1.301) que abre um painel à direita da conversa, no estilo do OpenCode:

- **Agora:** a ferramenta que está rodando e há quanto tempo
- **Pensamento:** as últimas linhas do raciocínio, ao vivo
- **Passos:** o plano, publicado pelo Claude com a ferramenta `mcp__painel__passos`
- **Arquivos:** cada arquivo editado com +/− linhas e o total
- **Subagentes** rodando e **contexto** (barra, tokens e custo estimado)

## Instalar

No prompt de uma sessão do Claude Code no terminal:

```
/plugin install painel --marketplace GabrielPauloT/painel-claude
```

Ele pergunta se pode adicionar o marketplace (responda `y`) e depois o escopo (o de usuário vem primeiro; Enter
escolhe). Pelo shell:

```sh
claude plugin install painel --marketplace GabrielPauloT/painel-claude
```

No app desktop, onde o `/plugin` não roda: clique no **+** ao lado da caixa do prompt, depois em **Plugins**,
**Add marketplace** com `GabrielPauloT/painel-claude` e então **Add plugin**.

Para desinstalar: `claude plugin uninstall painel@painel-claude`.

## Uso

- Abre sozinho em toda sessão interativa. Só encaixa à direita com `"tui": "fullscreen"` no
  `~/.claude/settings.json`; fora disso vira uma linha acima do prompt.
- `/painel` abre e fecha. Fechado, ele fica fechado nas próximas sessões até você abrir de novo.
- `/painel limpar` zera passos e arquivos.
- Linhas mudadas por `sed`/heredoc no Bash não entram na conta (só Edit, Write e NotebookEdit).
- Em sessão sem tela (`claude -p`, SDK) não registra a ferramenta nem abre o painel.

## Como mexer

Está instalado como plugin de usuário a partir **desta pasta** (marketplace local `painel-claude`):
o Claude Code lê os arquivos daqui. Editou, rode `/reload-plugins` na sessão.

| Arquivo | O quê |
| --- | --- |
| `hooks/register.tsx` | os hooks, a ferramenta `passos` e o desenho do painel |
| `hooks/util.ts` | funções puras: contagem de linhas, textos de ferramenta, cortes |
| `types/index.d.ts` | o contrato do `$.state` |
| `tests/painel.test.ts` | os testes |

Antes de recarregar:

```sh
claude plugin validate ~/projetos/painel-claude
claude plugin test ~/projetos/painel-claude
node ~/projetos/pixel-agents-linux/node_modules/typescript/bin/tsc -p ~/projetos/painel-claude
```

`.claude-plugin/types/` é um retrato da API da 2.1.301 para o editor e o `tsc`. Depois de atualizar o
Claude Code, peça ao Claude para atualizar esses tipos (a skill `plugin-authoring` grava os da versão em uso).

## Instalar de uma pasta local

```sh
claude plugin marketplace add ~/projetos/painel-claude
claude plugin install painel@painel-claude
claude plugin uninstall painel@painel-claude
```

Vale nas três contas do cswap: a troca de conta mexe só no `~/.claude.json` e na credencial, e os plugins
ficam em `~/.claude/settings.json` e `~/.claude/plugins/`. A exceção é o `cswap run <conta>`, que abre um
perfil isolado sem `plugins/`; lá seria preciso instalar de novo com `CLAUDE_CONFIG_DIR` apontando para o perfil.
