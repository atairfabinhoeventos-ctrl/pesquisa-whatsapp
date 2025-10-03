// ==================================================================
// ARQUIVO: index.js (Versão Completa Final para Servidor VM com Baileys)
// ==================================================================

// 1. IMPORTAÇÕES E CONFIGURAÇÃO
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1wSHcp496Wwpmcx3ANoF6UWai0qh0D-ccWsC0hSxWRrM';
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutos

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
// 2. FUNÇÕES DE APOIO
// ==================================================================
function clearConversationTimeout(contato) { if (userTimeouts[contato]) { clearTimeout(userTimeouts[contato]); delete userTimeouts[contato]; } }
function setConversationTimeout(contato, remoteJid) { clearConversationTimeout(contato); userTimeouts[contato] = setTimeout(() => { delete userState[contato]; delete userTimeouts[contato]; console.log(`[TIMEOUT] Conversa com ${contato} encerrada.`); sock.sendMessage(remoteJid, { text: '⏳ Sua sessão foi encerrada por inatividade. Envie uma nova mensagem se quiser recomeçar. 👋' }); }, CONVERSATION_TIMEOUT); }
async function loadSpreadsheet() { const doc = new GoogleSpreadsheet(SPREADSHEET_ID); await doc.useServiceAccountAuth(credenciais); await doc.loadInfo(); return doc; }
function formatarCPF(cpf) { const cpfLimpo = cpf.replace(/\D/g, ''); if (cpfLimpo.length !== 11) return null; return cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'); }
async function verificarStatusAdmin(contato) { try { const doc = await loadSpreadsheet(); const sheetCadastros = doc.sheetsByTitle['Cadastros']; if (!sheetCadastros) return false; const rowsCadastros = await sheetCadastros.getRows(); const usuarioCadastrado = rowsCadastros.find(row => row.IDContatoWhatsApp === contato); if (!usuarioCadastrado) return false; const cpfDoUsuario = usuarioCadastrado['CPF (xxx.xxx.xxx-xx)']; if (!cpfDoUsuario) return false; const sheetEventos = doc.sheetsByTitle['Eventos']; if (!sheetEventos) return false; const rowsEventos = await sheetEventos.getRows(); const isAdminEntry = rowsEventos.find(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.NomeEvento || '').trim() === 'ADMINISTRACAOGERAL'); return !!isAdminEntry; } catch (error) { console.error("Erro ao verificar status de admin:", error); return false; } }
async function gerarRelatorioDeLideres() { const doc = await loadSpreadsheet(); const sheetEventos = doc.sheetsByTitle['Eventos']; const rows = await sheetEventos.getRows(); const respondidas = rows.filter(row => (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' && row.Nota && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'); const dadosLideres = respondidas.reduce((acc, row) => { const lider = row.NomeLider; const nota = parseInt(row.Nota); if (!lider || isNaN(nota)) return acc; if (!acc[lider]) { acc[lider] = { lider: lider, notas: [], totalVotos: 0, media: 0 }; } acc[lider].notas.push(nota); acc[lider].totalVotos++; return acc; }, {}); const ranking = Object.values(dadosLideres).map(liderData => { const soma = liderData.notas.reduce((a, b) => a + b, 0); liderData.media = (soma / liderData.totalVotos).toFixed(2); delete liderData.notas; return liderData; }); ranking.sort((a, b) => b.media - a.media); return ranking; }
function formatarRelatorioParaWhatsApp(ranking) { let relatorio = '📊 *Relatório de Desempenho dos Líderes* 📊\n\n'; const medalhas = ['🥇', '🥈', '🥉']; if (ranking.length === 0) { return 'Nenhuma avaliação foi computada ainda para gerar um relatório.'; } ranking.forEach((lider, index) => { const posicao = index + 1; const medalha = medalhas[index] || `${posicao}️⃣`; relatorio += `${medalha} *${lider.lider}*\n`; relatorio += `   - Nota Média: *${lider.media}*\n`; relatorio += `   - Total de Votos: *${lider.totalVotos}*\n\n`; }); return relatorio; }
async function iniciarFluxoDePesquisa(contato, remoteJid, cpfDoUsuario) { try { const doc = await loadSpreadsheet(); const sheetEventos = doc.sheetsByTitle['Eventos']; if (!sheetEventos) { console.error("ERRO: A aba 'Eventos' não foi encontrada."); return; } const rowsEventos = await sheetEventos.getRows(); const pesquisasPendentes = rowsEventos.filter(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'); const footer = '\n\n\n*_Fabinho Eventos_*'; if (pesquisasPendentes.length === 0) { const saudacao = userState[contato]?.stage === 'cadastroFinalizado' ? '' : 'Olá! 👋 '; const msg = `${saudacao}Verificamos aqui e não há pesquisas pendentes para você no momento. Obrigado! 😊${footer}`; await sock.sendMessage(remoteJid, { text: msg }); delete userState[contato]; return; } if (pesquisasPendentes.length === 1) { const pesquisa = pesquisasPendentes[0]; userState[contato] = { stage: 'aguardandoNota', data: pesquisa }; const pergunta = `Olá! 👋 Vimos que você tem uma pesquisa pendente para o evento "${pesquisa.NomeEvento}".\n\nPara nos ajudar a melhorar, poderia avaliar o líder *${pesquisa.NomeLider}* com uma nota de 0 a 10? ✨`; await sock.sendMessage(remoteJid, { text: pergunta }); setConversationTimeout(contato, remoteJid); } else { userState[contato] = { stage: 'aguardandoEscolhaEvento', data: pesquisasPendentes }; let textoEscolha = 'Olá! 👋 Vimos que você tem mais de uma pesquisa pendente. Por favor, escolha qual evento gostaria de avaliar respondendo com o número correspondente:\n\n'; pesquisasPendentes.forEach((pesquisa, index) => { textoEscolha += `${index + 1}️⃣ Evento: *${pesquisa.NomeEvento}* (Líder: ${pesquisa.NomeLider})\n`; }); await sock.sendMessage(remoteJid, { text: textoEscolha }); setConversationTimeout(contato, remoteJid); } } catch (error) { console.error("Erro ao iniciar fluxo de pesquisa:", error); } }

// ==================================================================
// 3. CONEXÃO E LÓGICA PRINCIPAL DO BOT
// ==================================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: Browsers.macOS('Desktop') });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { console.log('[WHATSAPP] QR Code recebido, escaneie abaixo:'); qrcode.generate(qr, { small: true }); }
        if (connection === 'close') { const shouldReconnect = new Boom(lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut; console.log('[WHATSAPP] Conexão fechada. Reconectando:', shouldReconnect); if (shouldReconnect) { connectToWhatsApp(); } }
        else if (connection === 'open') { console.clear(); console.log('[WHATSAPP] Conexão aberta e cliente pronto!'); if(sock.user) console.log(`[WHATSAPP] Conectado como: ${sock.user.id.split(':')[0]}`); }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const contato = remoteJid.split('@')[0];
        const textoMsg = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        
        console.log(`[MSG RECEBIDA] De: ${contato} | Texto: "${textoMsg}"`);
        
        clearConversationTimeout(contato);

        try {
            const isAdmin = await verificarStatusAdmin(contato);
            const state = userState[contato];
            const footer = '\n\n\n*_Fabinho Eventos_*';
            const resposta = textoMsg.toLowerCase();

            // Roteador de Lógica Principal
            if (isAdmin) {
                if (!state || !state.stage?.startsWith('admin_')) {
                    userState[contato] = { stage: 'admin_menu' };
                    const menuAdmin = 'Olá, Administrador! 👋 Selecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Nova Pesquisa';
                    await sock.sendMessage(remoteJid, { text: menuAdmin });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_menu') {
                    if (textoMsg === '1') {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: '🔍 Gerando relatório, por favor, aguarde...' });
                        const ranking = await gerarRelatorioDeLideres();
                        const relatorioFormatado = formatarRelatorioParaWhatsApp(ranking);
                        await sock.sendMessage(remoteJid, { text: relatorioFormatado });
                    } else if (textoMsg === '2') {
                        state.stage = 'admin_aguardando_cpfs';
                        state.data = {};
                        await sock.sendMessage(remoteJid, { text: '📝 Certo! Por favor, envie a lista de CPFs dos participantes. Você pode separar por vírgula, espaço ou um por linha.' });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Opção inválida. Por favor, responda com `1` ou `2`." });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_aguardando_cpfs') {
                    const cpfsBrutos = textoMsg.match(/\d{11,}/g) || [];
                    const cpfsFormatados = cpfsBrutos.map(formatarCPF).filter(cpf => cpf !== null);
                    if (cpfsFormatados.length === 0) {
                        await sock.sendMessage(remoteJid, { text: '❌ Nenhum CPF válido encontrado. Por favor, envie uma lista de CPFs (apenas números).' });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }
                    state.data.cpfs = cpfsFormatados;
                    state.stage = 'admin_aguardando_nome_evento';
                    await sock.sendMessage(remoteJid, { text: `✅ ${cpfsFormatados.length} CPFs válidos encontrados. Agora, qual o *Nome do Evento*?` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_aguardando_nome_evento') {
                    state.data.nomeEvento = textoMsg;
                    state.stage = 'admin_aguardando_nome_lider';
                    await sock.sendMessage(remoteJid, { text: `🗓️ Evento "${textoMsg}" registrado. Agora, qual o *Nome do Líder* a ser avaliado?` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_aguardando_nome_lider') {
                    state.data.nomeLider = textoMsg;
                    state.stage = 'admin_aguardando_data_evento';
                    await sock.sendMessage(remoteJid, { text: `👤 Líder "${textoMsg}" registrado. Para finalizar, qual a *Data do Evento*? (ex: 03/10/2025)` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_aguardando_data_evento') {
                    state.data.dataEvento = textoMsg;
                    await sock.sendMessage(remoteJid, { text: `Salvando... ⏳` });
                    const doc = await loadSpreadsheet();
                    const sheetEventos = doc.sheetsByTitle['Eventos'];
                    const novasLinhas = state.data.cpfs.map(cpf => ({
                        'CPF (xxx.xxx.xxx-xx)': cpf,
                        'NomeEvento': state.data.nomeEvento,
                        'NomeLider': state.data.nomeLider,
                        'DataEvento': state.data.dataEvento,
                    }));
                    await sheetEventos.addRows(novasLinhas);
                    delete userState[contato];
                    await sock.sendMessage(remoteJid, { text: `🎉 *Sucesso!* ${state.data.cpfs.length} participantes foram cadastrados para a pesquisa do evento "${state.data.nomeEvento}".${footer}` });
                }
            } else if (state) {
                if (state.stage === 'aguardandoCPF') {
                    const cpfFormatado = formatarCPF(textoMsg);
                    if (!cpfFormatado) { await sock.sendMessage(remoteJid, { text: '❌ CPF inválido. Por favor, digite apenas os 11 números.' }); setConversationTimeout(contato, remoteJid); return; }
                    state.data.cpf = cpfFormatado;
                    state.stage = 'aguardandoConfirmacaoCPF';
                    await sock.sendMessage(remoteJid, { text: `📄 O CPF digitado foi: *${cpfFormatado}*. Está correto? (Responda 'Sim' ou 'Não')` });
                    setConversationTimeout(contato, remoteJid);
                } else if (state.stage === 'aguardandoConfirmacaoCPF') {
                    if (['sim', 's', 'correto'].includes(resposta)) {
                        state.stage = 'aguardandoNome';
                        await sock.sendMessage(remoteJid, { text: '👍 Ótimo! Agora, por favor, digite seu *Nome Completo*.' });
                        setConversationTimeout(contato, remoteJid);
                    } else if (['não', 'nao', 'n'].includes(resposta)) {
                        state.stage = 'aguardandoCPF';
                        await sock.sendMessage(remoteJid, { text: 'Ok, vamos tentar de novo. Por favor, digite seu CPF novamente.' });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Resposta inválida. Por favor, digite 'Sim' ou 'Não'." });
                        setConversationTimeout(contato, remoteJid);
                    }
                } else if (state.stage === 'aguardandoNome') {
                    state.data.nome = textoMsg;
                    state.stage = 'aguardandoTelefone';
                    await sock.sendMessage(remoteJid, { text: '✅ Nome registrado. Para finalizar, digite seu *telefone com DDD*.' });
                    setConversationTimeout(contato, remoteJid);
                } else if (state.stage === 'aguardandoTelefone') {
                    state.data.telefone = textoMsg.replace(/\D/g, '');
                    const doc = await loadSpreadsheet();
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    await sheetCadastros.addRow({ 'CPF (xxx.xxx.xxx-xx)': state.data.cpf, 'NomeCompleto': state.data.nome, 'TelefoneInformado': state.data.telefone, 'IDContatoWhatsApp': contato });
                    await sock.sendMessage(remoteJid, { text: '🎉 Cadastro finalizado! Obrigado. Vou verificar se há pesquisas para você.' });
                    userState[contato] = { stage: 'cadastroFinalizado', data: { cpf: state.data.cpf } };
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    await iniciarFluxoDePesquisa(contato, remoteJid, state.data.cpf);
                } 
                else if (state.stage === 'aguardandoNota') {
                    const nota = parseInt(textoMsg);
                    if (!isNaN(nota) && nota >= 0 && nota <= 10) {
                        const linhaParaAtualizar = state.data;
                        linhaParaAtualizar.Nota = nota;
                        linhaParaAtualizar.DataResposta = new Date().toLocaleDateString('pt-BR');
                        linhaParaAtualizar.PesquisaEnviada = 'TRUE';
                        await linhaParaAtualizar.save();
                        
                        const cpfDoUsuario = linhaParaAtualizar['CPF (xxx.xxx.xxx-xx)'];
                        const doc = await loadSpreadsheet();
                        const sheetEventos = doc.sheetsByTitle['Eventos'];
                        const rows = await sheetEventos.getRows();
                        const pesquisasRestantes = rows.filter(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');

                        if (pesquisasRestantes.length > 0) {
                            userState[contato] = { stage: 'aguardandoContinuar', data: { cpf: cpfDoUsuario } };
                            const perguntaContinuar = `✅ Avaliação registrada! Notamos que você tem mais pesquisas pendentes. Deseja avaliar outro evento agora? (Responda 'Sim' ou 'Não')`;
                            await sock.sendMessage(remoteJid, { text: perguntaContinuar });
                            setConversationTimeout(contato, remoteJid);
                        } else {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: `✅ Muito obrigado! Todas as suas pesquisas foram concluídas. ✨${footer}` });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Ops! Por favor, envie apenas um número de 0 a 10. 😉' });
                        setConversationTimeout(contato, remoteJid);
                    }
                } else if (state.stage === 'aguardandoEscolhaEvento') {
                    const escolha = parseInt(textoMsg);
                    if (!isNaN(escolha) && escolha > 0 && escolha <= state.data.length) {
                        const eventoEscolhido = state.data[escolha - 1];
                        userState[contato] = { stage: 'aguardandoNota', data: eventoEscolhido };
                        await sock.sendMessage(remoteJid, { text: `Ótimo! 👍 Para o evento "${eventoEscolhido.NomeEvento}", qual nota de 0 a 10 você daria para o líder *${eventoEscolhido.NomeLider}*?` });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ Por favor, responda com um número válido entre 1 e ${state.data.length}.` });
                        setConversationTimeout(contato, remoteJid);
                    }
                } else if (state.stage === 'aguardandoContinuar') {
                    if (['sim', 's', 'quero'].includes(resposta)) {
                        delete userState[contato];
                        await iniciarFluxoDePesquisa(contato, remoteJid, state.data.cpf);
                    } else if (['não', 'nao', 'n'].includes(resposta)) {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: `Tudo bem! Agradecemos seu tempo. Tenha um ótimo dia! 👋${footer}` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Resposta inválida. Por favor, digite 'Sim' ou 'Não'." });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
            } else {
                const doc = await loadSpreadsheet();
                const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                if (!sheetCadastros) { console.error("ERRO: A aba 'Cadastros' não foi encontrada."); return; }
                const rowsCadastros = await sheetCadastros.getRows();
                const usuarioCadastrado = rowsCadastros.find(row => row.IDContatoWhatsApp === contato);
                if (usuarioCadastrado) {
                    await iniciarFluxoDePesquisa(contato, remoteJid, usuarioCadastrado['CPF (xxx.xxx.xxx-xx)']);
                } else {
                    userState[contato] = { stage: 'aguardandoCPF', data: {} };
                    const msgBoasVindas = '*FABINHO EVENTOS*\n\nOlá! 👋 Seja bem-vindo(a) ao nosso sistema de pesquisas. Para começarmos, precisamos fazer um rápido cadastro.\n\nPor favor, digite seu *CPF* (apenas os números).';
                    await sock.sendMessage(remoteJid, { text: msgBoasVindas });
                    setConversationTimeout(contato, remoteJid);
                }
            }
        } catch (error) {
            console.error(`[ERRO GERAL] Falha ao processar mensagem de ${contato}:`, error);
        }
    });
}

connectToWhatsApp();

// ==================================================================
// 4. API PARA O DASHBOARD (EXPRESS)
// ==================================================================
app.get('/api/dados', async (req, res) => { try { const doc = await loadSpreadsheet(); const sheetEventos = doc.sheetsByTitle['Eventos']; const rows = await sheetEventos.getRows(); const dados = rows.map(row => ({ CPF: row['CPF (xxx.xxx.xxx-xx)'], NomeEvento: row.NomeEvento, NomeLider: row.NomeLider, PesquisaEnviada: row.PesquisaEnviada, Nota: row.Nota, DataResposta: row.DataResposta, })); res.json(dados); } catch (error) { console.error('Erro na rota /api/dados:', error); res.status(500).json({ error: 'Erro ao buscar dados da planilha.' }); } });
app.get('/api/estatisticas', async (req, res) => { try { const ranking = await gerarRelatorioDeLideres(); const doc = await loadSpreadsheet(); const sheetEventos = doc.sheetsByTitle['Eventos']; const rows = await sheetEventos.getRows(); const respondidas = rows.filter(row => (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'); const totalCadastros = rows.filter(row => (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL').length; const totalRespondidas = respondidas.length; const estatisticasLideres = ranking.reduce((acc, lider) => { acc[lider.lider] = { media: lider.media, totalRespostas: lider.totalVotos }; return acc; }, {}); res.json({ totalCadastros, totalRespondidas, estatisticasLideres: estatisticasLideres }); } catch (error) { console.error('Erro na rota /api/estatisticas:', error); res.status(500).json({ error: 'Erro ao calcular estatísticas.' }); } });
app.get('/', (req, res) => { res.send('Servidor do Bot de Pesquisa está online!'); });

// ==================================================================
// 5. INICIALIZAÇÃO DO SERVIDOR WEB
// ==================================================================
app.listen(PORT, () => {
    console.log(`[SERVIDOR] Dashboard e Bot iniciados na porta ${PORT}`);
});