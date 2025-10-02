const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
// Esta é a sua "senha" secreta. Pode manter esta ou criar uma nova.
const VERIFY_TOKEN = "FABINHO_EVENTOS_SECRET"; 

// O servidor começa a "escutar"
app.listen(PORT, () => console.log(`Servidor de Webhook rodando na porta ${PORT}. Pronto para verificação.`));

// Esta rota é a que a Meta vai chamar para verificar sua URL
app.get('/webhook', (req, res) => {
    // Verifica se a chamada de verificação é válida
    if (
        req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === VERIFY_TOKEN
    ) {
        // Se for válida, responde com o "desafio" que a Meta enviou
        res.send(req.query['hub.challenge']);
        console.log("Webhook verificado com sucesso pela Meta!");
    } else {
        // Se não, recusa a chamada
        console.error("Falha na verificação do Webhook. Tokens não correspondem.");
        res.sendStatus(403);
    }
});

// Esta rota receberá as mensagens do WhatsApp depois da verificação
app.post('/webhook', (req, res) => {
    console.log("Recebida uma notificação de mensagem (POST):", JSON.stringify(req.body, null, 2));
    res.sendStatus(200); // Responde OK para a Meta
});