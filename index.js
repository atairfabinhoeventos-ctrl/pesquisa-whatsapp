// ==================================================================
// ARQUIVO: index.js (Versão com Credenciamento e Blacklist)
// BLOCO 1 de 4: Importações e Configurações Iniciais
// ==================================================================

// 1. IMPORTAÇÕES E CONFIGURAÇÃO
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const ExcelJS = require('exceljs'); // <-- NOVO PACOTE ADICIONADO

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1wSHcp496Wwpmcx3ANoF6UWai0qh0D-ccWsC0hSxWRrM'; // Substitua pelo ID da sua planilha
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutos

const PERFIS_DISPONIVEIS = ['FREELANCER', 'LIDER_EVENTO', 'COORDENADOR', 'ADMIN_GERAL'];
const FUNCOES_EVENTO = ['Caixa Móvel', 'Caixa Fixo', 'Caixa Energético', 'Ajudante', 'Coordenador de Caixa', 'Líder', 'Financeiro'];

let credenciais;
try {
    credenciais = require('./credentials.json');
} catch (error) {
    console.error('ERRO FATAL: Arquivo "credentials.json" não encontrado.');
    process.exit(1);
}

const app = express();
app.use(express.static('public'));
let sock;
let userState = {};
let userTimeouts = {};

// ==================================================================
// BLOCO 2 de 4: Funções de Apoio
// ==================================================================

function clearConversationTimeout(contato) {
    if (userTimeouts[contato]) {
        clearTimeout(userTimeouts[contato]);
        delete userTimeouts[contato];
    }
}

function setConversationTimeout(contato, remoteJid) {
    clearConversationTimeout(contato);
    userTimeouts[contato] = setTimeout(() => {
        delete userState[contato];
        delete userTimeouts[contato];
        console.log(`[TIMEOUT] Conversa com ${contato} encerrada por inatividade.`);
        if (sock) {
            sock.sendMessage(remoteJid, { text: '⏳ Sua sessão foi encerrada por inatividade. Envie uma nova mensagem se quiser recomeçar. 👋' });
        }
    }, CONVERSATION_TIMEOUT);
}

async function loadSpreadsheet() {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
    await doc.useServiceAccountAuth(credenciais);
    await doc.loadInfo();
    return doc;
}

function validarEFormatarCPF(cpf) {
    const cpfLimpo = String(cpf).replace(/\D/g, '');

    if (cpfLimpo.length !== 11) {
        return { valido: false, motivo: 'O CPF precisa conter 11 dígitos.' };
    }

    if (/^(\d)\1{10}$/.test(cpfLimpo)) {
        return { valido: false, motivo: 'CPFs com todos os dígitos repetidos são inválidos.' };
    }

    let soma = 0;
    let resto;
    for (let i = 1; i <= 9; i++) soma += parseInt(cpfLimpo.substring(i - 1, i)) * (11 - i);
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(cpfLimpo.substring(9, 10))) {
        return { valido: false, motivo: 'O CPF informado é inválido (dígito verificador incorreto).' };
    }

    soma = 0;
    for (let i = 1; i <= 10; i++) soma += parseInt(cpfLimpo.substring(i - 1, i)) * (12 - i);
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(cpfLimpo.substring(10, 11))) {
        return { valido: false, motivo: 'O CPF informado é inválido (dígito verificador incorreto).' };
    }

    const cpfFormatado = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    return { valido: true, cpfFormatado: cpfFormatado, motivo: null };
}

async function obterUsuario(contato) {
    try {
        const doc = await loadSpreadsheet();
        const sheetCadastros = doc.sheetsByTitle['Cadastros'];
        if (!sheetCadastros) return null;
        const rows = await sheetCadastros.getRows();
        return rows.find(row => row.IDContatoWhatsApp === contato);
    } catch (error) {
        console.error("Erro ao obter usuário:", error);
        return null;
    }
}

// ##### NOVA FUNÇÃO INÍCIO #####
// Função para gerar a planilha Excel de credenciados
async function gerarPlanilhaCredenciados(nomeDoEvento) {
    try {
        console.log(`[DEBUG] Iniciando geração do Excel para o evento: "${nomeDoEvento}"`); // <--- LOG 1 (Opcional, mas bom ter)

        const doc = await loadSpreadsheet();
        const sheetCredenciamento = doc.sheetsByTitle['Credenciamento'];
        if (!sheetCredenciamento) {
            console.error("Aba 'Credenciamento' não encontrada.");
            return null;
        }
        const rows = await sheetCredenciamento.getRows();

        console.log(`[DEBUG] Total de credenciados na planilha: ${rows.length}`); // <--- ADICIONE ESTE LOG

        const credenciadosDoEvento = rows.filter(row => row['Nome do Evento'] === nomeDoEvento);

        console.log(`[DEBUG] Credenciados encontrados para "${nomeDoEvento}": ${credenciadosDoEvento.length}`); // <--- ADICIONE ESTE LOG


        if (credenciadosDoEvento.length === 0) {
            return null; // Retorna nulo se não houver dados para o evento
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Credenciados');

        // Define o cabeçalho da planilha
        worksheet.columns = [
            { header: 'Nome Completo', key: 'nome', width: 30 },
            { header: 'CPF', key: 'cpf', width: 20 },
            { header: 'Função', key: 'funcao', width: 25 },
            { header: 'Credenciado Por', key: 'credenciadoPor', width: 30 },
            { header: 'Data do Credenciamento', key: 'data', width: 25 },
            { header: 'Observação', key: 'obs', width: 30 }
        ];

        // Adiciona os dados
        credenciadosDoEvento.forEach(row => {
            worksheet.addRow({
                nome: row['Nome Completo'],
                cpf: row['CPF'],
                funcao: row['Função'],
                credenciadoPor: row['Credenciado Por'],
                data: row['Data do Credenciamento'],
                obs: row['Observação'] || ''
            });
        });

        // Gera o buffer do arquivo
        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;

    } catch (error) {
        console.error("Erro ao gerar planilha de credenciados:", error);
        return null;
    }
}
// ##### NOVA FUNÇÃO FIM #####

// ... (Restante das funções de relatório: parseDate, getAnsweredSurveys, etc. permanecem as mesmas)
async function getAnsweredSurveys() {
    const doc = await loadSpreadsheet();
    const sheetEventos = doc.sheetsByTitle['Eventos'];
    const rows = await sheetEventos.getRows();
    return rows.filter(row => (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' && row.Nota && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
}
const parseDate = (dateString) => {
    const parts = String(dateString).split('/');
    if (parts.length !== 3) return new Date(0); // Retorna uma data inválida se o formato estiver errado
    // Formato DD/MM/AAAA
    return new Date(parts[2], parts[1] - 1, parts[0]);
};
async function getAllSurveys() {
    const doc = await loadSpreadsheet();
    const sheetEventos = doc.sheetsByTitle['Eventos'];
    const rows = await sheetEventos.getRows();
    return rows.filter(row => (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
}

async function gerarRankingGeral() {
    const respondidas = await getAnsweredSurveys();
    const dadosLideres = respondidas.reduce((acc, row) => {
        const lider = row.NomeLider;
        const nota = parseInt(row.Nota);
        if (!lider || isNaN(nota)) return acc;
        if (!acc[lider]) {
            acc[lider] = { lider: lider, notas: [], totalVotos: 0, media: 0 };
        }
        acc[lider].notas.push(nota);
        acc[lider].totalVotos++;
        return acc;
    }, {});
    const ranking = Object.values(dadosLideres).map(liderData => {
        const soma = liderData.notas.reduce((a, b) => a + b, 0);
        liderData.media = (soma / liderData.totalVotos).toFixed(2);
        delete liderData.notas;
        return liderData;
    });
    ranking.sort((a, b) => b.media - a.media);
    return ranking;
}

async function gerarResultadoPorEvento() {
    const respondidas = await getAnsweredSurveys();
    const dadosEventosPorMes = respondidas.reduce((acc, row) => {
        const evento = row.NomeEvento;
        const nota = parseInt(row.Nota);
        if (!evento || isNaN(nota) || !row.DataEvento) return acc;
        const [dia, mes, ano] = row.DataEvento.split('/');
        if (!mes || !ano) return acc;
        const chaveMes = `${String(mes).padStart(2, '0')}/${ano}`;
        if (!acc[chaveMes]) {
            acc[chaveMes] = {};
        }
        if (!acc[chaveMes][evento]) {
            acc[chaveMes][evento] = { evento: evento, notas: [], totalVotos: 0, media: 0, data: parseDate(row.DataEvento) };
        }
        acc[chaveMes][evento].notas.push(nota);
        acc[chaveMes][evento].totalVotos++;
        return acc;
    }, {});
    for (const mes in dadosEventosPorMes) {
        for (const evento in dadosEventosPorMes[mes]) {
            const eventoData = dadosEventosPorMes[mes][evento];
            const soma = eventoData.notas.reduce((a, b) => a + b, 0);
            eventoData.media = (soma / eventoData.totalVotos).toFixed(2);
            delete eventoData.notas;
        }
    }
    return dadosEventosPorMes;
}

async function gerarRelatorioDeAdesao() {
    const todas = await getAllSurveys();
    const dadosAdesao = todas.reduce((acc, row) => {
        const evento = row.NomeEvento;
        if (!evento || !row.DataEvento) return acc;
        const [dia, mes, ano] = row.DataEvento.split('/');
        if (!mes || !ano) return acc;
        const chaveMes = `${String(mes).padStart(2, '0')}/${ano}`;
        if (!acc[chaveMes]) { acc[chaveMes] = {}; }
        if (!acc[chaveMes][evento]) { acc[chaveMes][evento] = { cadastradas: 0, respondidas: 0, data: parseDate(row.DataEvento) }; }
        acc[chaveMes][evento].cadastradas++;
        if ((row.PesquisaEnviada || '').toUpperCase() === 'TRUE') {
            acc[chaveMes][evento].respondidas++;
        }
        return acc;
    }, {});
    return dadosAdesao;
}

function formatarRankingGeral(ranking) {
    let relatorio = '📊 *Ranking Geral de Líderes* 📊\n\n';
    const medalhas = ['🥇', '🥈', '🥉'];
    if (ranking.length === 0) { return 'Nenhuma avaliação foi computada.'; }
    ranking.forEach((lider, index) => {
        const posicao = index + 1;
        const medalha = medalhas[index] || `${posicao}️⃣`;
        relatorio += `${medalha} *${lider.lider}*\n`;
        relatorio += `   - Nota Média: *${lider.media}*\n`;
        relatorio += `   - Total de Votos: *${lider.totalVotos}*\n\n`;
    });
    return relatorio;
}

function formatarResultadoPorEvento(resultadoPorMes) {
    let relatorio = '🗓️ *Resultado por Evento (Agrupado por Mês)* 🗓️\n\n';
    const mesesOrdenados = Object.keys(resultadoPorMes).sort((a, b) => {
        const [mesA, anoA] = a.split('/');
        const [mesB, anoB] = b.split('/');
        return new Date(anoB, mesB - 1) - new Date(anoA, mesA - 1);
    });
    if (mesesOrdenados.length === 0) { return 'Nenhum evento com avaliações.'; }
    mesesOrdenados.forEach(chaveMes => {
        const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
        const [mesNum, ano] = chaveMes.split('/');
        relatorio += `*${meses[parseInt(mesNum) - 1]} de ${ano}:*\n`;
        const eventosDoMes = Object.values(resultadoPorMes[chaveMes]).sort((a, b) => b.data - a.data);
        eventosDoMes.forEach(evento => {
            relatorio += `  - *${evento.evento}*: Média *${evento.media}* (Votos: ${evento.totalVotos})\n`;
        });
        relatorio += '\n';
    });
    return relatorio;
}

function formatarRelatorioAdesao(adesao) {
    let relatorio = '📈 *Relatório de Adesão às Pesquisas* 📈\n\n';
    const mesesOrdenados = Object.keys(adesao).sort((a, b) => {
        const [mesA, anoA] = a.split('/');
        const [mesB, anoB] = b.split('/');
        return new Date(anoB, mesB - 1) - new Date(anoA, mesA - 1);
    });
    if (mesesOrdenados.length === 0) { return 'Nenhuma pesquisa cadastrada.'; }
    mesesOrdenados.forEach(chaveMes => {
        const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
        const [mesNum, ano] = chaveMes.split('/');
        relatorio += `*${meses[parseInt(mesNum) - 1]} de ${ano}:*\n`;
        const eventosDoMes = adesao[chaveMes];
        for (const nomeEvento in eventosDoMes) {
            const dados = eventosDoMes[nomeEvento];
            const percentual = dados.cadastradas > 0 ? ((dados.respondidas / dados.cadastradas) * 100).toFixed(1) : 0;
            relatorio += `  - *${nomeEvento}*: ${dados.respondidas} de ${dados.cadastradas} responderam (*${percentual}%*)\n`;
        }
        relatorio += '\n';
    });
    return relatorio;
}

async function iniciarFluxoDePesquisa(contato, remoteJid, usuario) {
    try {
        const cpfDoUsuario = usuario['CPF (xxx.xxx.xxx-xx)'];
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        if (!sheetEventos) { console.error("ERRO: A aba 'Eventos' (de pesquisas) não foi encontrada."); return; }
        const rowsEventos = await sheetEventos.getRows();
        const pesquisasPendentes = rowsEventos.filter(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
        const footer = '\n\n\n*_Fabinho Eventos_*';
        
        if (pesquisasPendentes.length === 0) {
            const msg = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n\nVerificamos aqui e não há pesquisas de satisfação pendentes para você no momento.\n\nPara ficar por dentro das novidades e futuros eventos, siga nosso Instagram!\n➡️ https://www.instagram.com/eventos.fabinho/\n\n${footer}`;
            await sock.sendMessage(remoteJid, { text: msg });
            delete userState[contato];
            return;
        }
        
        if (pesquisasPendentes.length === 1) {
            const pesquisa = pesquisasPendentes[0];
            userState[contato] = { stage: 'aguardandoNota', data: pesquisa };
            const pergunta = `Olá! 👋 Vimos que você tem uma pesquisa pendente para o evento "${pesquisa.NomeEvento}".\n\nPara nos ajudar a melhorar, poderia avaliar o líder *${pesquisa.NomeLider}* com uma nota de 0 a 10? ✨`;
            await sock.sendMessage(remoteJid, { text: pergunta });
            setConversationTimeout(contato, remoteJid);
        } else {
            userState[contato] = { stage: 'aguardandoEscolhaEvento', data: pesquisasPendentes };
            let textoEscolha = 'Olá! 👋 Vimos que você tem mais de uma pesquisa pendente. Por favor, escolha qual evento gostaria de avaliar respondendo com o número correspondente:\n\n';
            pesquisasPendentes.forEach((pesquisa, index) => { textoEscolha += `${index + 1}️⃣ Evento: *${pesquisa.NomeEvento}* (Líder: ${pesquisa.NomeLider})\n`; });
            await sock.sendMessage(remoteJid, { text: textoEscolha });
            setConversationTimeout(contato, remoteJid);
        }
    } catch (error) {
        console.error("Erro ao iniciar fluxo de pesquisa:", error);
    }
}

// ==================================================================
// BLOCO 3 de 4: Conexão e Lógica Principal do Bot (VERSÃO ATUALIZADA)
// ==================================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: Browsers.macOS('Desktop') });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('[WHATSAPP] QR Code recebido, escaneie abaixo:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[WHATSAPP] Conexão fechada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('[WHATSAPP] Conexão aberta e cliente pronto!');
            if (sock.user) {
                console.log(`[WHATSAPP] Conectado como: ${sock.user.id.split(':')[0]}`);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ##### ALTERAÇÃO INÍCIO: Nova função helper para processar o próximo CPF da lista #####
    async function processarCpfDaLista(contato, remoteJid) {
        const state = userState[contato];
        if (!state || !state.data.listaCpfs || state.data.indiceAtual >= state.data.listaCpfs.length) {
            delete userState[contato];
            await sock.sendMessage(remoteJid, { text: '✅ Todos os CPFs da lista foram processados! Credenciamento finalizado.' });
            return;
        }

        const cpfAtual = state.data.listaCpfs[state.data.indiceAtual];
        const contador = `(${state.data.indiceAtual + 1}/${state.data.listaCpfs.length})`;

        await sock.sendMessage(remoteJid, { text: `Processando próximo CPF... ${contador} ⏳` });

        const doc = await loadSpreadsheet();
        // VERIFICAÇÃO NA BLACKLIST
        const sheetBlacklist = doc.sheetsByTitle['Blacklist'];
        const rowsBlacklist = await sheetBlacklist.getRows();
        const naBlacklist = rowsBlacklist.find(row => row.CPF === cpfAtual);
        if (naBlacklist) {
            await sock.sendMessage(remoteJid, { text: `🚫 *ATENÇÃO: CPF na Blacklist!* ${contador}\nO CPF *${cpfAtual}* está bloqueado e não pode ser credenciado.\n*Motivo:* ${naBlacklist.Motivo}\n\nPulando para o próximo...` });
            state.data.indiceAtual++;
            await processarCpfDaLista(contato, remoteJid); // Pula para o próximo
            return;
        }

        // BUSCA DADOS DO PARTICIPANTE
        const sheetCadastros = doc.sheetsByTitle['Cadastros'];
        const rowsCadastros = await sheetCadastros.getRows();
        const participante = rowsCadastros.find(row => row['CPF (xxx.xxx.xxx-xx)'] === cpfAtual);
        if (!participante) {
            await sock.sendMessage(remoteJid, { text: `⚠️ CPF não encontrado na base de cadastros. ${contador}\nO CPF *${cpfAtual}* não foi encontrado.\n\nPulando para o próximo...` });
            state.data.indiceAtual++;
            await processarCpfDaLista(contato, remoteJid); // Pula para o próximo
            return;
        }
        
        state.data.cpfAtual = cpfAtual;
        state.data.nomeCompletoAtual = participante.NomeCompleto;
        state.stage = 'credenciamento_confirma_pessoa';

        await sock.sendMessage(remoteJid, { text: `*Credenciamento ${contador}*\n\nEncontrei este usuário:\n\n*Nome:* ${state.data.nomeCompletoAtual}\n*CPF:* ${state.data.cpfAtual}\n\nEstá correto? (Responda 'Sim' ou 'Não')` });
        setConversationTimeout(contato, remoteJid);
    }
    // ##### ALTERAÇÃO FIM #####

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const contato = remoteJid.split('@')[0];
        const textoMsg = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

        console.log(`[MSG RECEBIDA] De: ${contato} | Texto: "${textoMsg}"`);

        try {
            const usuario = await obterUsuario(contato);
            const perfil = (usuario?.Perfil || '').toUpperCase();
            const state = userState[contato];
            const resposta = textoMsg.toLowerCase();
            
            const menuAdmin = `Olá, ${usuario?.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: ADMIN_GERAL*\n\nSelecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Nova Pesquisa\n*3.* Alterar Perfil de Usuário\n*4.* Gerenciar Blacklist\n*5.* Credenciar Participante\n*6.* Realizar Substituição\n*7.* Exportar Credenciados (Excel)\n*8.* Verificar Versão do Bot\n*0.* Sair`;
            const menuLider = `Olá, ${usuario?.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: LÍDER DE EVENTO*\n\nSelecione uma opção:\n\n*1.* Cadastrar Novo Evento\n*2.* Gerenciar Blacklist\n*3.* Credenciar Participante\n*4.* Realizar Substituição\n*5.* Exportar Credenciados (Excel)\n*0.* Sair`;
            const menuCoordenador = `Olá, ${usuario?.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: COORDENADOR*\n\nSelecione uma opção:\n\n*1.* Credenciar Participante\n*2.* Realizar Substituição\n*0.* Sair`;


            if (state) {
                if (state.stage === 'coordenador_menu') {
                    if (textoMsg === '1') { // Credenciar Participante
                        state.stage = 'credenciamento_pede_evento';
                        
                        const doc = await loadSpreadsheet();
                        const sheetEventosCadastrados = doc.sheetsByTitle['Eventos_Cadastrados'];
                        const rows = await sheetEventosCadastrados.getRows();
                        const eventosDisponiveis = rows.sort((a,b) => parseDate(b['Data do Evento']) - parseDate(a['Data do Evento']));

                        if (eventosDisponiveis.length === 0) {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: 'Nenhum evento cadastrado para credenciamento no momento.' });
                            return;
                        }

                        let textoEventos = 'Para qual evento deseja credenciar?\n\n';
                        eventosDisponiveis.forEach((evento, index) => {
                            textoEventos += `*${index + 1}.* ${evento['Nome do Evento']} (${evento['Data do Evento']})\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: textoEventos });
                        setConversationTimeout(contato, remoteJid);

                    } else if (textoMsg === '2') { // Realizar Substituição
                        state.stage = 'substituicao_pede_evento';

                        const doc = await loadSpreadsheet();
                        const sheetEventosCadastrados = doc.sheetsByTitle['Eventos_Cadastrados'];
                        const rows = await sheetEventosCadastrados.getRows();
                        const eventosDisponiveis = rows.sort((a,b) => parseDate(b['Data do Evento']) - parseDate(a['Data do Evento']));

                        if (eventosDisponiveis.length === 0) {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: 'Nenhum evento encontrado para realizar substituições.' });
                            return;
                        }

                        let textoEventos = 'Para qual evento deseja realizar a substituição?\n\n';
                        eventosDisponiveis.forEach((evento, index) => {
                            textoEventos += `*${index + 1}.* ${evento['Nome do Evento']} (${evento['Data do Evento']})\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: textoEventos });
                        setConversationTimeout(contato, remoteJid);

                    } else if (textoMsg === '0') {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: 'Sessão encerrada.' });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'Opção inválida. Por favor, escolha uma das opções do menu.' });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'lider_menu') {
                    if (textoMsg === '1') { // Cadastrar Novo Evento
                        state.stage = 'lider_cad_evento_nome';
                        await sock.sendMessage(remoteJid, { text: "Ok, vamos cadastrar um novo evento. Qual será o *nome do evento*?" });
                        setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '2') { // Gerenciar Blacklist
                         state.stage = 'admin_blacklist_menu';
                         const menuBlacklist = "Gerenciar Blacklist:\n\n1. Adicionar CPF\n2. Consultar CPF\n3. Remover CPF\n0. Voltar";
                         await sock.sendMessage(remoteJid, { text: menuBlacklist });
                         setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '3') { // Credenciar Participante
                        state.stage = 'credenciamento_pede_evento';

                        const doc = await loadSpreadsheet();
                        const sheetEventosCadastrados = doc.sheetsByTitle['Eventos_Cadastrados'];
                        const rows = await sheetEventosCadastrados.getRows();
                        const eventosDisponiveis = rows.sort((a,b) => parseDate(b['Data do Evento']) - parseDate(a['Data do Evento']));

                        if (eventosDisponiveis.length === 0) {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: 'Nenhum evento cadastrado para credenciamento no momento.' });
                            return;
                        }

                        let textoEventos = 'Para qual evento deseja credenciar?\n\n';
                        eventosDisponiveis.forEach((evento, index) => {
                            textoEventos += `*${index + 1}.* ${evento['Nome do Evento']} (${evento['Data do Evento']})\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: textoEventos });
                        setConversationTimeout(contato, remoteJid);

                    } else if (textoMsg === '4') { // Realizar Substituição
                        state.stage = 'substituicao_pede_evento';

                        const doc = await loadSpreadsheet();
                        const sheetEventosCadastrados = doc.sheetsByTitle['Eventos_Cadastrados'];
                        const rows = await sheetEventosCadastrados.getRows();
                        const eventosDisponiveis = rows.sort((a,b) => parseDate(b['Data do Evento']) - parseDate(a['Data do Evento']));

                        if (eventosDisponiveis.length === 0) {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: 'Nenhum evento encontrado para realizar substituições.' });
                            return;
                        }

                        let textoEventos = 'Para qual evento deseja realizar a substituição?\n\n';
                        eventosDisponiveis.forEach((evento, index) => {
                            textoEventos += `*${index + 1}.* ${evento['Nome do Evento']} (${evento['Data do Evento']})\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: textoEventos });
                        setConversationTimeout(contato, remoteJid);

                    } else if (textoMsg === '5') { // Exportar Credenciados (Excel)
                        state.stage = 'exportar_pede_evento';

                        const doc = await loadSpreadsheet();
                        const sheetEventosCadastrados = doc.sheetsByTitle['Eventos_Cadastrados'];
                        const rows = await sheetEventosCadastrados.getRows();
                        const eventosDisponiveis = rows.sort((a,b) => parseDate(b['Data do Evento']) - parseDate(a['Data do Evento']));

                        if (eventosDisponiveis.length === 0) {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: 'Nenhum evento encontrado para exportar.' });
                            return;
                        }

                        let textoEventos = 'De qual evento deseja exportar a lista de credenciados?\n\n';
                        eventosDisponiveis.forEach((evento, index) => {
                            textoEventos += `*${index + 1}.* ${evento['Nome do Evento']} (${evento['Data do Evento']})\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: textoEventos });
                        setConversationTimeout(contato, remoteJid);

                    } else if (textoMsg === '0') {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: 'Sessão encerrada.' });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'Opção inválida. Por favor, escolha uma das opções do menu.' });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_menu') {
                    const doc = await loadSpreadsheet();
                    
                    const listarEventos = async () => {
                        const sheetEventosCadastrados = doc.sheetsByTitle['Eventos_Cadastrados'];
                        const rows = await sheetEventosCadastrados.getRows();
                        const eventosDisponiveis = rows.sort((a,b) => parseDate(b['Data do Evento']) - parseDate(a['Data do Evento']));
                        if (eventosDisponiveis.length === 0) return null;
                        let lista = '';
                        eventosDisponiveis.forEach((evento, index) => {
                            lista += `*${index + 1}.* ${evento['Nome do Evento']} (${evento['Data do Evento']})\n`;
                        });
                        return { lista, eventos: eventosDisponiveis };
                    };

                    switch (textoMsg) {
                        case '1':
                            state.stage = 'admin_resultados_menu';
                            const menuResultados = 'Selecione o relatório que deseja visualizar:\n\n1. Ranking Geral de Líderes\n2. Resultado por Evento\n3. Relatório de Adesão\n0. Voltar';
                            await sock.sendMessage(remoteJid, { text: menuResultados });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        case '2':
                            state.stage = 'admin_cad_pesquisa_cpfs';
                            await sock.sendMessage(remoteJid, { text: "Ok. Para iniciar, envie a lista de CPFs dos participantes, um por linha ou separados por vírgula." });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        case '3':
                            state.stage = 'admin_alt_perfil_pede_cpf';
                            await sock.sendMessage(remoteJid, { text: "Qual o CPF do usuário que você deseja alterar o perfil?" });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        case '4':
                            state.stage = 'admin_blacklist_menu';
                            const menuBlacklist = "Gerenciar Blacklist:\n\n1. Adicionar CPF\n2. Consultar CPF\n3. Remover CPF\n0. Voltar";
                            await sock.sendMessage(remoteJid, { text: menuBlacklist });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        case '5':
                            state.stage = 'credenciamento_pede_evento';
                            const eventosCred = await listarEventos();
                            if (!eventosCred) { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Nenhum evento cadastrado para credenciamento.' }); return; }
                            await sock.sendMessage(remoteJid, { text: `Para qual evento deseja credenciar?\n\n${eventosCred.lista}` });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        case '6':
                            state.stage = 'substituicao_pede_evento';
                            const eventosSub = await listarEventos();
                            if (!eventosSub) { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Nenhum evento encontrado para realizar substituições.' }); return; }
                            await sock.sendMessage(remoteJid, { text: `Para qual evento deseja realizar a substituição?\n\n${eventosSub.lista}` });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        case '7':
                            state.stage = 'exportar_pede_evento';
                            const eventosExp = await listarEventos();
                            if (!eventosExp) { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Nenhum evento encontrado para exportar.' }); return; }
                            await sock.sendMessage(remoteJid, { text: `De qual evento deseja exportar a lista de credenciados?\n\n${eventosExp.lista}` });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        case '8':
                            try {
                                const git = require('git-rev-sync');
                                const versao = git.short();
                                const branch = git.branch();
                                const dataCommit = git.date();
                                const msgVersao = `*-- Versão do Bot --*\n\n*Branch:* \`${branch}\`\n*Último Commit (hash):* \`${versao}\`\n*Data do Commit:* ${dataCommit.toLocaleString('pt-BR')}`;
                                await sock.sendMessage(remoteJid, { text: msgVersao });
                                setConversationTimeout(contato, remoteJid);
                            } catch (e) {
                                await sock.sendMessage(remoteJid, { text: "Não foi possível verificar a versão. O bot talvez não esteja rodando de uma pasta Git." });
                            }
                            break;
                        case '0':
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: "Sessão encerrada." });
                            break;
                        default:
                            await sock.sendMessage(remoteJid, { text: 'Opção inválida. Por favor, escolha uma das opções do menu.' });
                            setConversationTimeout(contato, remoteJid);
                            break;
                    }
                }
                else if (state.stage === 'credenciamento_pede_evento') {
                    const doc = await loadSpreadsheet();
                    const sheetEventosCadastrados = doc.sheetsByTitle['Eventos_Cadastrados'];
                    const rows = await sheetEventosCadastrados.getRows();
                    const eventosDisponiveis = rows.sort((a,b) => parseDate(b['Data do Evento']) - parseDate(a['Data do Evento']));
                    if (eventosDisponiveis.length === 0) { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Nenhum evento cadastrado para credenciamento no momento.'}); return; }
                    
                    const escolha = parseInt(textoMsg);
                    if (!isNaN(escolha) && escolha > 0 && escolha <= eventosDisponiveis.length) {
                        const eventoEscolhido = eventosDisponiveis[escolha - 1];
                        state.data = {
                            nomeEvento: eventoEscolhido['Nome do Evento'],
                            funcoesDisponiveis: eventoEscolhido['Funções Disponíveis'].split(',').map(f => f.trim())
                        };
                        state.stage = 'credenciamento_pede_cpf';
                        await sock.sendMessage(remoteJid, { text: `✅ Evento *${state.data.nomeEvento}* selecionado.\n\nAgora, por favor, envie a *lista de CPFs* que deseja credenciar (um por linha, ou separados por vírgula/espaço).` });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: `Opção inválida. Por favor, escolha um número de 1 a ${eventosDisponiveis.length}.` });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'credenciamento_pede_cpf') {
                    if (resposta === 'cancelar') { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Ação cancelada.' }); return; }

                    const cpfsEncontrados = textoMsg.match(/(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})/g) || [];
                    if (cpfsEncontrados.length === 0) {
                        await sock.sendMessage(remoteJid, { text: `Nenhum CPF válido encontrado na mensagem. Por favor, envie uma lista de CPFs (apenas números ou no formato xxx.xxx.xxx-xx).` });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }
                    
                    let cpfsValidos = [];
                    let cpfsInvalidos = [];

                    for (const cpf of cpfsEncontrados) {
                        const resultado = validarEFormatarCPF(cpf);
                        if (resultado.valido) {
                            cpfsValidos.push(resultado.cpfFormatado);
                        } else {
                            cpfsInvalidos.push(cpf);
                        }
                    }
                    
                    cpfsValidos = [...new Set(cpfsValidos)];

                    if (cpfsValidos.length === 0) {
                        await sock.sendMessage(remoteJid, { text: `Todos os CPFs enviados são inválidos ou estão em formato incorreto. Por favor, tente novamente.\n\nInválidos: ${cpfsInvalidos.join(', ')}` });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }
                    
                    state.data.listaCpfs = cpfsValidos;
                    state.data.indiceAtual = 0;
                    
                    let resumoMsg = `Encontrei *${cpfsValidos.length}* CPFs válidos para processar.`;
                    if (cpfsInvalidos.length > 0) {
                        resumoMsg += `\n*${cpfsInvalidos.length}* CPFs foram ignorados por serem inválidos.`;
                    }
                    resumoMsg += `\n\nIniciando o credenciamento...`;
                    
                    await sock.sendMessage(remoteJid, { text: resumoMsg });
                    await processarCpfDaLista(contato, remoteJid);
                }
                else if (state.stage === 'credenciamento_confirma_pessoa') {
                     if (['sim', 's'].includes(resposta)) {
                        state.stage = 'credenciamento_pede_funcao';
                        let textoFuncoes = `👍 Certo! Agora, escolha a função para *${state.data.nomeCompletoAtual}*:\n\n`;
                        state.data.funcoesDisponiveis.forEach((funcao, index) => {
                            textoFuncoes += `*${index + 1}.* ${funcao}\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: textoFuncoes });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: `Ok, participante *${state.data.nomeCompletoAtual}* ignorado. Pulando para o próximo...` });
                        state.data.indiceAtual++;
                        await processarCpfDaLista(contato, remoteJid);
                    }
                }
                else if (state.stage === 'credenciamento_pede_funcao') {
                    const escolha = parseInt(textoMsg);
                    if (!isNaN(escolha) && escolha > 0 && escolha <= state.data.funcoesDisponiveis.length) {
                        const funcaoEscolhida = state.data.funcoesDisponiveis[escolha - 1];
                        
                        const doc = await loadSpreadsheet();
                        const sheetCredenciamento = doc.sheetsByTitle['Credenciamento'];
                        await sheetCredenciamento.addRow({
                            'Nome do Evento': state.data.nomeEvento,
                            'CPF': state.data.cpfAtual,
                            'Nome Completo': state.data.nomeCompletoAtual,
                            'Função': funcaoEscolhida,
                            'Credenciado Por': usuario.NomeCompleto,
                            'Data do Credenciamento': new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
                        });
                        
                        await sock.sendMessage(remoteJid, { text: `✅ *${state.data.nomeCompletoAtual}* credenciado(a) como *${funcaoEscolhida}*!` });
                        
                        state.data.indiceAtual++;
                        await processarCpfDaLista(contato, remoteJid);

                    } else {
                        await sock.sendMessage(remoteJid, { text: `Opção inválida. Escolha um número de 1 a ${state.data.funcoesDisponiveis.length}.` });
                        setConversationTimeout(contato, remoteJid);
                    }
                }

            } else {
                if (perfil === 'ADMIN_GERAL') {
                    userState[contato] = { stage: 'admin_menu' };
                    await sock.sendMessage(remoteJid, { text: menuAdmin });
                    setConversationTimeout(contato, remoteJid);
                } else if (perfil === 'LIDER_EVENTO') {
                    userState[contato] = { stage: 'lider_menu' };
                    await sock.sendMessage(remoteJid, { text: menuLider });
                    setConversationTimeout(contato, remoteJid);
                } else if (perfil === 'COORDENADOR') {
                    userState[contato] = { stage: 'coordenador_menu' };
                    await sock.sendMessage(remoteJid, { text: menuCoordenador });
                    setConversationTimeout(contato, remoteJid);
                } else if (perfil === 'FREELANCER') {
                    await iniciarFluxoDePesquisa(contato, remoteJid, usuario);
                } else {
                    userState[contato] = { stage: 'aguardandoCPF', data: {} };
                    const msgBoasVindas = '*FABINHO EVENTOS*\n\nOlá! 👋 Para acessar nosso sistema, precisamos fazer um rápido cadastro.\n\nPor favor, digite seu *CPF* (apenas os números).';
                    await sock.sendMessage(remoteJid, { text: msgBoasVindas });
                    setConversationTimeout(contato, remoteJid);
                }
            }
        } catch (error) {
            console.error(`[ERRO GERAL] Falha ao processar mensagem de ${contato}:`, error);
             if (userState[contato]) {
                delete userState[contato];
                await sock.sendMessage(remoteJid, {text: "Ocorreu um erro inesperado e sua operação foi cancelada. Por favor, tente novamente."});
            }
        }
    });
}

connectToWhatsApp();

// ==================================================================
// ==================================================================
// BLOCO 4 de 4: API do Dashboard e Inicialização do Servidor
// ==================================================================

// 4. API PARA O DASHBOARD (EXPRESS)
app.get('/api/dados', async (req, res) => {
    try {
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        const rows = await sheetEventos.getRows();
        const dados = rows.map(row => ({
            CPF: row['CPF (xxx.xxx.xxx-xx)'],
            NomeEvento: row.NomeEvento,
            NomeLider: row.NomeLider,
            PesquisaEnviada: row.PesquisaEnviada,
            Nota: row.Nota,
            DataResposta: row.DataResposta,
        }));
        res.json(dados);
    } catch (error) {
        console.error('Erro na rota /api/dados:', error);
        res.status(500).json({ error: 'Erro ao buscar dados da planilha.' });
    }
});

app.get('/api/estatisticas', async (req, res) => {
    try {
        const ranking = await gerarRankingGeral(); // Corrigido de gerarRelatorioDeLideres para a função existente
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        const rows = await sheetEventos.getRows();
        
        const respondidas = rows.filter(row => (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
        const totalCadastros = rows.filter(row => (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL').length;
        const totalRespondidas = respondidas.length;
        
        const estatisticasLideres = ranking.reduce((acc, lider) => {
            acc[lider.lider] = {
                media: lider.media,
                totalRespostas: lider.totalVotos
            };
            return acc;
        }, {});

        res.json({
            totalCadastros,
            totalRespondidas,
            estatisticasLideres: estatisticasLideres
        });

    } catch (error) {
        console.error('Erro na rota /api/estatisticas:', error);
        res.status(500).json({ error: 'Erro ao calcular estatísticas.' });
    }
});

// Rota de verificação simples para saber se o servidor está online
app.get('/', (req, res) => {
    res.send('Servidor do Bot de Pesquisa está online!');
});


// 5. INICIALIZAÇÃO DO SERVIDOR WEB
app.listen(PORT, () => {
    console.log(`[SERVIDOR] Dashboard e Bot iniciados na porta ${PORT}`);
});