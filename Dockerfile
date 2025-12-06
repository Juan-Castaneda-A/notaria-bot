# Usamos una imagen ligera de Node 20
FROM node:20-bullseye-slim

# Instalamos solo lo esencial:
# - git: por si alguna dependencia viene de github
# - build-essential y python3: necesarios para compilar módulos nativos (como bufferutil) que Baileys usa para velocidad
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de configuración primero (para aprovechar la caché de Docker)
COPY package*.json ./

# Instalar dependencias
# --production hace que no instale "devDependencies" si las tienes, ahorrando espacio
RUN npm install --production

# Copiar el resto del código
COPY . .

# Render ignora el EXPOSE, pero es buena práctica documentarlo.
# Tu código usa process.env.PORT o 10000, así que ponemos 10000
EXPOSE 10000

# Arrancar
CMD ["node", "index.js"]