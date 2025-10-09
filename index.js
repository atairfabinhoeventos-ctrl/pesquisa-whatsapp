// ==================================================================
// ARQUIVO: index.js (Versão Simplificada - Foco em Pesquisa e Relatórios)
// BLOCO 1 de 4: Importações e Configurações Iniciais
// ==================================================================

// 1. IMPORTAÇÕES E CONFIGURAÇÃO
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1wSHcp496Wwpmcx3ANoF6UWai0qh0D-ccWsC0hSxWRrM'; // Substitua pelo ID da sua planilha
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutos

// Perfis simplificados
const PERFIS_DISPONIVEIS = ['FREELANCER', 'ADMIN_GERAL']; 

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
        return { valido: false, motivo: 'O CPF informado é inválido.' };
    }
    soma = 0;
    for (let i = 1; i <= 10; i++) soma += parseInt(cpfLimpo.substring(i - 1, i)) * (12 - i);
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(cpfLimpo.substring(10, 11))) {
        return { valido: false, motivo: 'O CPF informado é inválido.' };
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

const parseDate = (dateString) => {
    const parts = String(dateString).split('/');
    if (parts.length !== 3) return new Date(0);
    return new Date(parts[2], parts[1] - 1, parts[0]);
};

async function getAnsweredSurveys() {
    const doc = await loadSpreadsheet();
    const sheetEventos = doc.sheetsByTitle['Eventos'];
    const rows = await sheetEventos.getRows();
    return rows.filter(row => (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' && row.Nota && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
}

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
        if (!acc[chaveMes]) acc[chaveMes] = {};
        if (!acc[chaveMes][evento]) acc[chaveMes][evento] = { evento: evento, notas: [], totalVotos: 0, media: 0, data: parseDate(row.DataEvento) };
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
        if (!acc[chaveMes]) acc[chaveMes] = {};
        if (!acc[chaveMes][evento]) acc[chaveMes][evento] = { cadastradas: 0, respondidas: 0, data: parseDate(row.DataEvento) };
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
    if (ranking.length === 0) return 'Nenhuma avaliação foi computada.';
    ranking.forEach((lider, index) => {
        const posicao = index + 1;
        const medalha = medalhas[index] || `${posicao}️⃣`;
        relatorio += `${medalha} *${lider.lider}*\n   - Nota Média: *${lider.media}*\n   - Total de Votos: *${lider.totalVotos}*\n\n`;
    });
    return relatorio;
}

function formatarResultadoPorEvento(resultadoPorMes) {
    let relatorio = '🗓️ *Resultado por Evento (Agrupado por Mês)* 🗓️\n\n';
    const mesesOrdenados = Object.keys(resultadoPorMes).sort((a, b) => {
        const [mesA, anoA] = a.split('/'); const [mesB, anoB] = b.split('/');
        return new Date(anoB, mesB - 1) - new Date(anoA, mesA - 1);
    });
    if (mesesOrdenados.length === 0) return 'Nenhum evento com avaliações.';
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
        const [mesA, anoA] = a.split('/'); const [mesB, anoB] = b.split('/');
        return new Date(anoB, mesB - 1) - new Date(anoA, mesA - 1);
    });
    if (mesesOrdenados.length === 0) return 'Nenhuma pesquisa cadastrada.';
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
            const msg = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n\nVerificamos aqui e não há pesquisas de satisfação pendentes para você no momento.\n\n${footer}`;
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
// BLOCO 3 de 4: Conexão e Lógica Principal do Bot
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
            
            // Menu Admin Simplificado
            const menuAdmin = `Olá, ${usuario?.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: ADMIN_GERAL*\n\nSelecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Nova Pesquisa\n*3.* Alterar Perfil de Usuário\n*4.* Verificar Versão do Bot\n*0.* Sair`;

            if (state) {
                // ########## FLUXO DE CADASTRO DE NOVO USUÁRIO ##########
                if (state.stage === 'aguardandoCPF') {
                    const resultadoValidacao = validarEFormatarCPF(textoMsg);
                    if (!resultadoValidacao.valido) {
                        await sock.sendMessage(remoteJid, { text: `❌ CPF inválido. ${resultadoValidacao.motivo} Por favor, tente novamente.` });
                        return;
                    }
                    state.data.cpf = resultadoValidacao.cpfFormatado;
                    state.stage = 'confirmandoCPF';
                    await sock.sendMessage(remoteJid, { text: `Você digitou: *${state.data.cpf}*. Está correto? (Sim/Não)` });
                    setConversationTimeout(contato, remoteJid);
                } 
                else if (state.stage === 'confirmandoCPF') {
                    if (textoMsg.toLowerCase() === 'sim') {
                        state.stage = 'aguardandoNome';
                        await sock.sendMessage(remoteJid, { text: 'Ótimo! Qual o seu nome completo?' });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        state.stage = 'aguardandoCPF';
                        await sock.sendMessage(remoteJid, { text: 'Ok, por favor, digite seu CPF novamente.' });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'aguardandoNome') {
                    state.data.nome = textoMsg;
                    state.stage = 'aguardandoTelefone';
                    await sock.sendMessage(remoteJid, { text: 'Obrigado! E qual o seu telefone com DDD?' });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'aguardandoTelefone') {
                    state.data.telefone = textoMsg;
                    
                    const doc = await loadSpreadsheet();
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    await sheetCadastros.addRow({
                        'IDContatoWhatsApp': contato,
                        'CPF (xxx.xxx.xxx-xx)': state.data.cpf,
                        'NomeCompleto': state.data.nome,
                        'Telefone': state.data.telefone,
                        'Perfil': 'FREELANCER'
                    });

                    delete userState[contato];
                    clearConversationTimeout(contato);

                    await sock.sendMessage(remoteJid, { text: '✅ Cadastro concluído com sucesso! Obrigado.' });
                    
                    const novoUsuario = await obterUsuario(contato);
                    await iniciarFluxoDePesquisa(contato, remoteJid, novoUsuario);
                }

                // ########## FLUXO DE AVALIAÇÃO (PESQUISA) ##########
                else if (state.stage === 'aguardandoEscolhaEvento') {
                    const escolha = parseInt(textoMsg);
                    if (!isNaN(escolha) && escolha > 0 && escolha <= state.data.length) {
                        const pesquisa = state.data[escolha - 1];
                        userState[contato] = { stage: 'aguardandoNota', data: pesquisa };
                        const pergunta = `Ok! Para o evento "${pesquisa.NomeEvento}", qual nota de 0 a 10 você daria para o líder *${pesquisa.NomeLider}*?`;
                        await sock.sendMessage(remoteJid, { text: pergunta });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'Opção inválida. Por favor, responda com um dos números da lista.' });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'aguardandoNota') {
                    const nota = parseInt(textoMsg);
                    if (isNaN(nota) || nota < 0 || nota > 10) {
                        await sock.sendMessage(remoteJid, { text: 'Nota inválida. Por favor, envie um número de 0 a 10.' });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }

                    const pesquisa = state.data;
                    pesquisa.Nota = nota;
                    pesquisa.PesquisaEnviada = 'TRUE';
                    pesquisa.DataResposta = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                    await pesquisa.save();

                    await sock.sendMessage(remoteJid, { text: '✅ Obrigado pela sua avaliação!' });
                    
                    const usuarioAtual = await obterUsuario(contato);
                    const cpfDoUsuario = usuarioAtual['CPF (xxx.xxx.xxx-xx)'];
                    const doc = await loadSpreadsheet();
                    const sheetEventos = doc.sheetsByTitle['Eventos'];
                    const rowsEventos = await sheetEventos.getRows();
                    const pesquisasPendentes = rowsEventos.filter(row => row['CPF (xxx.xxx.xxx-xx)'] === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE');

                    if (pesquisasPendentes.length > 0) {
                        userState[contato] = { stage: 'aguardandoContinuar', data: usuarioAtual };
                        await sock.sendMessage(remoteJid, { text: 'Você ainda tem outras pesquisas pendentes. Deseja continuar avaliando? (Sim/Não)' });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        delete userState[contato];
                        clearConversationTimeout(contato);
                        await sock.sendMessage(remoteJid, { text: 'Você concluiu todas as suas avaliações. Muito obrigado!' });
                    }
                }
                else if (state.stage === 'aguardandoContinuar') {
                    if (textoMsg.toLowerCase() === 'sim') {
                        await iniciarFluxoDePesquisa(contato, remoteJid, state.data);
                    } else {
                        delete userState[contato];
                        clearConversationTimeout(contato);
                        await sock.sendMessage(remoteJid, { text: 'Ok! Obrigado por participar.' });
                    }
                }

                // ########## FLUXO DO ADMIN ##########
                else if (state.stage === 'admin_menu') {
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


                // ##### CÓDIGO PARA ADICIONAR INÍCIO #####
                else if (state.stage === 'admin_resultados_menu') {
                    let relatorio;
                    // Remove o timeout, pois a ação será concluída agora ou o usuário voltará ao menu
                    clearConversationTimeout(contato);

                    switch (textoMsg) {
                        case '1':
                            await sock.sendMessage(remoteJid, { text: 'Gerando Ranking Geral de Líderes... 📊' });
                            const ranking = await gerarRankingGeral();
                            relatorio = formatarRankingGeral(ranking);
                            await sock.sendMessage(remoteJid, { text: relatorio });
                            delete userState[contato]; // Encerra a conversa após o relatório
                            break;
                        case '2':
                            await sock.sendMessage(remoteJid, { text: 'Gerando Resultado por Evento... 🗓️' });
                            const resultado = await gerarResultadoPorEvento();
                            relatorio = formatarResultadoPorEvento(resultado);
                            await sock.sendMessage(remoteJid, { text: relatorio });
                            delete userState[contato]; // Encerra a conversa após o relatório
                            break;
                        case '3':
                            await sock.sendMessage(remoteJid, { text: 'Gerando Relatório de Adesão... 📈' });
                            const adesao = await gerarRelatorioDeAdesao();
                            relatorio = formatarRelatorioAdesao(adesao);
                            await sock.sendMessage(remoteJid, { text: relatorio });
                            delete userState[contato]; // Encerra a conversa após o relatório
                            break;
                        case '0':
                            // Volta para o menu anterior
                            state.stage = 'admin_menu';
                            await sock.sendMessage(remoteJid, { text: menuAdmin });
                            setConversationTimeout(contato, remoteJid);
                            break;
                        default:
                            await sock.sendMessage(remoteJid, { text: 'Opção inválida. Por favor, escolha uma das opções do menu.' });
                            setConversationTimeout(contato, remoteJid); // Mantém o usuário neste menu para tentar de novo
                            break;
                    }
                }

                // ##### CÓDIGO PARA ADICIONAR (PARTE 1) INÍCIO #####
                else if (state.stage === 'admin_cad_pesquisa_cpfs') {
                    const cpfs = textoMsg.split(/[\s,]+/).filter(cpf => cpf.trim() !== '');
                    if (cpfs.length === 0) {
                        await sock.sendMessage(remoteJid, { text: 'Nenhum CPF foi enviado. Por favor, envie a lista de CPFs.' });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }
                    state.data = { cpfs };
                    state.stage = 'admin_cad_pesquisa_nome_evento';
                    await sock.sendMessage(remoteJid, { text: `Ok, recebi ${cpfs.length} CPFs. Qual é o nome do evento?` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_cad_pesquisa_nome_evento') {
                    state.data.nomeEvento = textoMsg;
                    state.stage = 'admin_cad_pesquisa_nome_lider';
                    await sock.sendMessage(remoteJid, { text: 'Qual o nome do líder que será avaliado?' });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_cad_pesquisa_nome_lider') {
                    state.data.nomeLider = textoMsg;
                    state.stage = 'admin_cad_pesquisa_data';
                    await sock.sendMessage(remoteJid, { text: 'Qual a data do evento? (Formato DD/MM/AAAA)' });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_cad_pesquisa_data') {
                    state.data.dataEvento = textoMsg;
                    await sock.sendMessage(remoteJid, { text: 'Processando... Por favor, aguarde. Isso pode levar um momento.' });

                    const doc = await loadSpreadsheet();
                    const sheetEventos = doc.sheetsByTitle['Eventos'];
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    const rowsCadastros = await sheetCadastros.getRows();

                    const novasLinhas = [];
                    for (const cpfInput of state.data.cpfs) {
                        const resultadoValidacao = validarEFormatarCPF(cpfInput);
                        if (resultadoValidacao.valido) {
                            const cpfFormatado = resultadoValidacao.cpfFormatado;
                            const usuarioCadastro = rowsCadastros.find(row => row['CPF (xxx.xxx.xxx-xx)'] === cpfFormatado);

                            novasLinhas.push({
                                'CPF (xxx.xxx.xxx-xx)': cpfFormatado,
                                'Nome Freelancer': usuarioCadastro ? usuarioCadastro.NomeCompleto : 'CPF não cadastrado',
                                'NomeEvento': state.data.nomeEvento,
                                'NomeLider': state.data.nomeLider,
                                'DataEvento': state.data.dataEvento
                            });
                        }
                    }

                    if (novasLinhas.length > 0) {
                        await sheetEventos.addRows(novasLinhas);
                        await sock.sendMessage(remoteJid, { text: `✅ Pesquisa para o evento "${state.data.nomeEvento}" cadastrada com sucesso para ${novasLinhas.length} CPFs!` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'Nenhum CPF válido foi processado.' });
                    }

                    delete userState[contato];
                    clearConversationTimeout(contato);
                }
                // ##### CÓDIGO PARA ADICIONAR (PARTE 1) FIM #####


                // ##### CÓDIGO PARA ADICIONAR (PARTE 2) INÍCIO #####
                else if (state.stage === 'admin_alt_perfil_pede_cpf') {
                    const resultadoValidacao = validarEFormatarCPF(textoMsg);
                    if (!resultadoValidacao.valido) {
                        await sock.sendMessage(remoteJid, { text: `CPF inválido. ${resultadoValidacao.motivo}. Tente novamente.` });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }
                    const doc = await loadSpreadsheet();
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    const rows = await sheetCadastros.getRows();
                    const usuarioParaAlterar = rows.find(row => row['CPF (xxx.xxx.xxx-xx)'] === resultadoValidacao.cpfFormatado);

                    if (!usuarioParaAlterar) {
                        await sock.sendMessage(remoteJid, { text: 'CPF não encontrado na base de dados. Tente novamente.' });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }
                    state.data = { usuario: usuarioParaAlterar };
                    state.stage = 'admin_alt_perfil_confirma';
                    await sock.sendMessage(remoteJid, { text: `Usuário encontrado: *${usuarioParaAlterar.NomeCompleto}*. Perfil atual: *${usuarioParaAlterar.Perfil}*. Deseja alterar? (Sim/Não)` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_alt_perfil_confirma') {
                    if (textoMsg.toLowerCase() === 'sim') {
                        state.stage = 'admin_alt_perfil_pede_perfil';
                        let textoPerfis = 'Para qual perfil você deseja alterar?\n\n';
                        PERFIS_DISPONIVEIS.forEach((perfil, index) => {
                            textoPerfis += `*${index + 1}.* ${perfil}\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: textoPerfis });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        delete userState[contato];
                        clearConversationTimeout(contato);
                        await sock.sendMessage(remoteJid, { text: 'Operação cancelada.' });
                    }
                }
                else if (state.stage === 'admin_alt_perfil_pede_perfil') {
                    const escolha = parseInt(textoMsg);
                    if (!isNaN(escolha) && escolha > 0 && escolha <= PERFIS_DISPONIVEIS.length) {
                        const novoPerfil = PERFIS_DISPONIVEIS[escolha - 1];
                        state.data.usuario.Perfil = novoPerfil;
                        await state.data.usuario.save();
                        
                        delete userState[contato];
                        clearConversationTimeout(contato);
                        await sock.sendMessage(remoteJid, { text: `✅ Perfil de *${state.data.usuario.NomeCompleto}* alterado com sucesso para *${novoPerfil}*!` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'Opção inválida. Por favor, escolha um dos números da lista.' });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                // ##### CÓDIGO PARA ADICIONAR (PARTE 2) FIM #####

                // ##### CÓDIGO PARA ADICIONAR FIM #####

                    } else {
                        // Início de uma nova conversa
                        if (perfil === 'ADMIN_GERAL') {
                            userState[contato] = { stage: 'admin_menu' };
                            await sock.sendMessage(remoteJid, { text: menuAdmin });
                            setConversationTimeout(contato, remoteJid);
                        } else { // Trata FREELANCER e qualquer outro perfil como padrão
                            const usuarioExistente = await obterUsuario(contato);
                            if (usuarioExistente) {
                                await iniciarFluxoDePesquisa(contato, remoteJid, usuarioExistente);
                            } else {
                                userState[contato] = { stage: 'aguardandoCPF', data: {} };
                                const msgBoasVindas = '*FABINHO EVENTOS*\n\nOlá! 👋 Para acessar nosso sistema, precisamos fazer um rápido cadastro.\n\nPor favor, digite seu *CPF* (apenas os números).';
                                await sock.sendMessage(remoteJid, { text: msgBoasVindas });
                                setConversationTimeout(contato, remoteJid);
                            }
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
        const ranking = await gerarRankingGeral();
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

app.get('/', (req, res) => {
    res.send('Servidor do Bot de Pesquisa está online!');
});


// 5. INICIALIZAÇÃO DO SERVIDOR WEB
app.listen(PORT, () => {
    console.log(`[SERVIDOR] Dashboard e Bot iniciados na porta ${PORT}`);
});