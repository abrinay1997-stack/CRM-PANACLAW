-- Las credenciales de WhatsApp, fuera del disco del contenedor.
--
-- Esto es lo que reemplaza a `useMultiFileAuthState` de BukoFlow: allá los
-- archivos vivían en ./whatsapp-auth/ y había que respaldarlos a mano en la
-- variable WA_AUTH de Railway. Aquí son filas, y sobreviven a que Cloudflare
-- mueva, reinicie o reconstruya el contenedor.
--
-- La fila que importa es `creds`: mientras exista, no hay QR nuevo. Las demás
-- son llaves de sesión de Signal y Baileys las regenera si faltan.
CREATE TABLE IF NOT EXISTS wa_humo_auth (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en INTEGER NOT NULL
);
