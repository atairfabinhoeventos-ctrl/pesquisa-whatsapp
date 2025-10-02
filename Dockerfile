# Etapa 1: Usar uma imagem oficial e leve do Node.js v20 (a que funciona)
FROM node:20-slim

# Etapa 2: Definir o diretório de trabalho dentro do nosso "mini-computador"
WORKDIR /usr/src/app

# Etapa 3: Copiar os arquivos de definição de pacotes
COPY package*.json ./

# Etapa 4: Instalar as dependências do projeto de forma otimizada
RUN npm install --omit=dev

# Etapa 5: Copiar todo o resto do seu código (index.js, etc.) para dentro
COPY . .

# Etapa 6: Informar ao Render qual porta nosso app usa
EXPOSE 10000

# Etapa 7: O comando final para iniciar o bot
CMD [ "node", "index.js" ]