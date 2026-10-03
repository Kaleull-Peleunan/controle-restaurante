# Comanda

MVP web para operacao de mesas, pedidos e pagamentos. O Express serve a interface em `public/` e a API; os dados ficam no PostgreSQL.

## Requisitos

- Node.js 20 ou superior
- PostgreSQL 16 ou Docker com Docker Compose

## Execucao local com Docker

1. Copie `.env.example` para `.env`.
2. No `.env`, defina uma senha de administrador e um `JWT_SECRET` aleatorio com pelo menos 32 caracteres.
3. Inicie o banco: `docker compose up -d db`.
4. Instale os pacotes: `npm install`.
5. Inicie a aplicacao: `npm start`.
6. Acesse `http://localhost:3000`.

O esquema e os dados iniciais sao criados no primeiro inicio do servidor. O usuario inicial usa `ADMIN_EMAIL` e `ADMIN_PASSWORD` do `.env`; se omitidos, o MVP usa `admin@restaurante.com` e `admin123`. Troque esses valores antes de qualquer uso fora do ambiente local.

Sem Docker, configure `DATABASE_URL` para uma instancia PostgreSQL acessivel e execute `npm start`.

## Migrar dados do sistema inicial

1. Antes de trocar de sistema, abra a versão inicial e use **Configurações → Exportar backup**. Guarde o JSON em local seguro.
2. Inicie esta versão conectada ao PostgreSQL e entre com uma conta administradora.
3. Abra **Configurações + backup → Migrar dados do sistema inicial**, selecione o JSON e confirme.
4. A importação é transacional: se houver erro de validação ou conflito com uma comanda aberta, nenhum registro do arquivo é aplicado. O banco existente não é apagado.

Produtos com mesmo nome e categoria e mesas existentes são reutilizados; comandas com identificador legado já importado são ignoradas em novas tentativas. Os demais produtos, comandas, itens, pagamentos, avisos e perfis de equipe são acrescentados. O rateio de pagamentos por item é mantido quando o backup inclui os identificadores originais; históricos fechados que não os contêm preservam o pagamento, mas não permitem reconstruir esse rateio. A importação aumenta a quantidade de mesas ativas quando necessário, sem reduzir a configuração atual; nome, descontos, exigência de garçom e taxa são importados somente quando a configuração correspondente do destino ainda está no valor padrão. Perfis de equipe legados são criados como contas inativas: defina um email e uma senha nova antes de ativá-los. PINs não são convertidos. Maquininhas são mantidas apenas como configuração arquivada, sem endereço de bridge; a trilha de auditoria e os demais dados do arquivo sanitizado ficam disponíveis no backup administrativo. Exporte um novo backup depois da migração.

## API

- `GET /api/health`: disponibilidade da API e conexao com o banco.
- `POST /api/login`: autentica e emite um JWT.
- `GET /api/tables`, `GET /api/products`: dados da operacao autenticada.
- `POST /api/products`, `PATCH /api/products/:id`, `DELETE /api/products/:id`: catálogo administrativo; exclusão desativa o produto para preservar o histórico.
- `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`: contas administrativas e seus perfis.
- `/api/orders`: abertura, edição de itens, PIN da equipe, desconto com autorização, taxa de serviço, pagamento integral ou dividido por item, estorno interno, transferência, junção, cancelamento e fechamento de comandas.
- `GET /api/history`: ultimas 200 comandas encerradas.
- `GET /api/production?station=kitchen|bar`: fila de itens abertos para cozinha ou bar.
- `PATCH /api/production/:itemId/status`: atualiza o preparo (`pending`, `preparing`, `ready`).
- `/api/settings` e `/api/products/:id/production-station`: configurações administrativas, incluindo nome, quantidade de mesas, descontos, exigência de garçom e taxa de serviço.
- `GET /api/notices`, `POST /api/notices`, `PATCH /api/notices/:id/read`: avisos da equipe.
- `GET /api/reports?from=AAAA-MM-DD&to=AAAA-MM-DD&waiterId=...&paymentMethod=...`: resumo e comandas fechadas, com filtros; consultas acima de 1.000 comandas exigem intervalo menor.
- `GET /api/audit`: trilha de auditoria, restrita ao administrador.
- `POST /api/migration/import-legacy`: importação administrativa do backup JSON inicial.
- `GET /api/backup`: exportação JSON administrativa dos dados cadastrados.

As rotas operacionais usam `Authorization: Bearer <token>`. Valores recebidos pelo cliente sao validados no servidor e as operacoes de pedido/pagamento usam transacoes.

## Ainda fora do escopo

Pagamentos e estornos são registros internos: não processam cobrança nem devolução em maquininhas. Integração TEF, conexão fiscal, recuperação de senha, backup automatizado e deploy de produção ainda exigem serviços e configuração adicionais. A tela **Configurações** mantém as funções operacionais disponíveis, imprime recibos e tickets de produção, permite baixar um backup manual e importar dados legados. O arquivo de backup inclui hashes de senha e dados legados sanitizados; armazene-o com acesso restrito. A exportação não substitui uma estratégia automatizada de backup e restauração do PostgreSQL. Antes de operar com dados reais, configure HTTPS, segredos seguros, backup/restauração e revise as permissões por função.