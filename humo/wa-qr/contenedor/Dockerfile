# Imagen de la prueba de humo. Se construye desde wrangler y se empuja al
# registro de Cloudflare — por eso el token necesita "Cloudflare Images: Edit".
#
# Node 22 y no 20: es el mismo piso que exige wrangler, y no vale la pena correr
# el runtime del contenedor en una versión que ya se está retirando.
FROM node:22-bookworm-slim

WORKDIR /app

# Las dependencias primero, en su propia capa: mientras package.json no cambie,
# reconstruir tras editar servidor.mjs no vuelve a bajar Baileys entero.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY servidor.mjs ./

# El Worker habla con este puerto vía ctx.container.getTcpPort(8080).
EXPOSE 8080

# Sin capa de init: si el proceso de Node se cae, queremos que el contenedor
# muera y que el Worker lo note y lo levante. Un supervisor adentro escondería
# exactamente el fallo que esta prueba busca medir.
CMD ["node", "servidor.mjs"]
