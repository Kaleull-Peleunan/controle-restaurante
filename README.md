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

Produtos com mesmo nome e categoria e mesas existentes são reutilizados; comandas com identificador legado já importado são ignoradas em novas tentativas. Os demais produtos, comandas, itens, pagamentos e perfis de equipe são acrescentados. A importação aumenta a quantidade de mesas ativas quando necessário, sem reduzir a configuração atual. Perfis de equipe legados são criados como contas inativas: defina um email e uma senha nova antes de ativá-los. PINs não são convertidos. Maquininhas são mantidas apenas como configuração arquivada, sem endereço de bridge; a trilha de auditoria e os demais dados do arquivo sanitizado ficam disponíveis no backup administrativo. Exporte um novo backup depois da migração.

## API

- `GET /api/health`: disponibilidade da API e conexao com o banco.
- `POST /api/login`: autentica e emite um JWT.
- `GET /api/tables`, `GET /api/products`: dados da operacao autenticada.
- `POST /api/products`, `PATCH /api/products/:id`, `DELETE /api/products/:id`: catálogo administrativo; exclusão desativa o produto para preservar o histórico.
- `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`: contas administrativas e seus perfis.
- `/api/orders`: abertura, itens, desconto, pagamento e fechamento de comandas.
- `GET /api/history`: ultimas 200 comandas encerradas.
- `GET /api/production?station=kitchen|bar`: fila de itens abertos para cozinha ou bar.
- `PATCH /api/production/:itemId/status`: atualiza o preparo (`pending`, `preparing`, `ready`).
- `/api/settings` e `/api/products/:id/production-station`: configurações administrativas, incluindo nome e quantidade de mesas.
- `GET /api/notices`, `POST /api/notices`, `PATCH /api/notices/:id/read`: avisos da equipe.
- `POST /api/migration/import-legacy`: importação administrativa do backup JSON inicial.
- `GET /api/backup`: exportação JSON administrativa dos dados cadastrados.

As rotas operacionais usam `Authorization: Bearer <token>`. Valores recebidos pelo cliente sao validados no servidor e as operacoes de pedido/pagamento usam transacoes.

## Ainda fora do escopo

Este MVP nao processa pagamentos reais, nao tem integracao fiscal, recuperacao de senha, autenticacao por PIN, fluxo de divisao/movimentacao/juncao/cancelamento de comandas, auditoria operacional completa, backup automatizado ou deploy configurado. A tela **Configurações** permite manter nome e quantidade de mesas, catálogo e contas, além de baixar um backup manual e importar dados legados. O arquivo de backup inclui hashes de senha e o arquivo legado sanitizado; armazene-o com acesso restrito. A exportação não substitui uma estratégia automatizada de backup e restauração do PostgreSQL. O pagamento registrado é apenas controle interno. Antes de operar com dados reais, configure HTTPS, segredos seguros, backup/restauração e revisão de permissões por função.